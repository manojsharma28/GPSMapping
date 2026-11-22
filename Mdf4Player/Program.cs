using System.Globalization;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using Mdf4Net;
using Mdf4Net.BusLogging;

internal static class Program
{
    private static readonly string[] LatitudeNames = ["latitude", "lat", "gpslatitude", "gpslat"];
    private static readonly string[] LongitudeNames = ["longitude", "lon", "lng", "gpslongitude", "gpslon", "gpslng"];
    private static readonly string[] ValidityNames = ["positionvalid", "gpsvalid", "locationvalid"];
    private const double DirectionChangeThresholdDegrees = 8;
    private static readonly HttpClient HttpClient = new() { Timeout = TimeSpan.FromSeconds(15) };
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);

    private sealed record Options(
        string File,
        string PublisherUrl,
        string Id,
        string? Label,
        string? LatitudeChannel,
        string? LongitudeChannel,
        string? Database,
        double Speed);

    private sealed record ChannelLocation(int GroupIndex, Mdf4ChannelGroup Group, Mdf4Channel Channel);
    private sealed record GpsFix(double Latitude, double Longitude, DateTimeOffset Timestamp, double Elapsed);
    private sealed record PlaybackSummary(string Status, string Id, int Points, string LatitudeChannel, string LongitudeChannel);
    private sealed record Coordinate(double Latitude, double Longitude);
    private sealed record TrackStart(string Type, string Id, string? Label, Coordinate Start, Coordinate End);
    private sealed record PublishedFix(string Id, string? Label, double Latitude, double Longitude, DateTimeOffset Timestamp);

    private sealed record DbcSignal(string Name, int StartBit, int Length, bool LittleEndian, bool Signed, double Factor, double Offset);
    private sealed record DbcMessage(uint Id, IReadOnlyList<DbcSignal> Signals);

    public static async Task<int> Main(string[] args)
    {
        try
        {
            var options = ParseArguments(args);
            var (decodedFixes, latitudeChannel, longitudeChannel) = DecodeMdf(options);
            var fixes = ReduceStraightLineFixes(decodedFixes);
            await PublishFixesAsync(fixes, options);

            Console.WriteLine(JsonSerializer.Serialize(
                new PlaybackSummary("published", options.Id, fixes.Count, latitudeChannel, longitudeChannel),
                JsonOptions));
            return 0;
        }
        catch (ArgumentException error)
        {
            Console.Error.WriteLine($"MDF4 playback failed: {error.Message}");
            return 2;
        }
        catch (Exception error)
        {
            Console.Error.WriteLine($"MDF4 playback failed: {error.Message}");
            return 1;
        }
    }

    private static Options ParseArguments(string[] args)
    {
        if (args.Length == 1 && args[0] is "--help" or "-h")
        {
            Console.WriteLine("Usage: Mdf4Player <file> --publisher-url URL [--database DBC] [--latitude-channel NAME] [--longitude-channel NAME] [--id ID] [--label LABEL] [--speed 0..1000]");
            Environment.Exit(0);
        }

        if (args.Length == 0)
            throw new ArgumentException("Usage: Mdf4Player <file> --publisher-url URL [--database DBC] [--latitude-channel NAME] [--longitude-channel NAME] [--id ID] [--label LABEL] [--speed 0..1000]");

        var values = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        var file = args[0];
        for (var index = 1; index < args.Length; index++)
        {
            var name = args[index];
            if (!name.StartsWith("--", StringComparison.Ordinal) || index + 1 >= args.Length)
                throw new ArgumentException($"Expected a value after {name}.");
            if (!values.TryAdd(name, args[++index]))
                throw new ArgumentException($"Option {name} was specified more than once.");
        }

        string Required(string name) =>
            values.TryGetValue(name, out var value) ? value : throw new ArgumentException($"Missing required option {name}.");

        string? Optional(string name) => values.TryGetValue(name, out var value) ? value : null;

        foreach (var name in values.Keys)
        {
            if (name is not ("--publisher-url" or "--database" or "--latitude-channel" or "--longitude-channel" or "--id" or "--label" or "--speed"))
                throw new ArgumentException($"Unknown option {name}.");
        }

        var publisherUrl = Required("--publisher-url");
        if (!Uri.TryCreate(publisherUrl, UriKind.Absolute, out var publisherUri) ||
            publisherUri.Scheme is not ("http" or "https"))
            throw new ArgumentException("--publisher-url must be an absolute HTTP or HTTPS URL.");

        var database = Optional("--database");
        if (!System.IO.File.Exists(file))
            throw new ArgumentException($"MDF4 file does not exist: {file}");
        if (database is not null && !System.IO.File.Exists(database))
            throw new ArgumentException($"DBC file does not exist: {database}");

        var id = Optional("--id") ?? "mdf4-track";
        var label = Optional("--label");
        if (string.IsNullOrWhiteSpace(id) || id.Length > 128 || (label is not null && label.Length > 128))
            throw new ArgumentException("Device ID and label must be between 1 and 128 characters.");

        var speed = Optional("--speed") is { } speedText
            ? double.Parse(speedText, NumberStyles.Float, CultureInfo.InvariantCulture)
            : 10d;
        if (!double.IsFinite(speed) || speed < 0 || speed > 1000)
            throw new ArgumentException("--speed must be between 0 and 1000.");

        var latitudeChannel = Optional("--latitude-channel");
        var longitudeChannel = Optional("--longitude-channel");
        if (latitudeChannel?.Length > 256 || longitudeChannel?.Length > 256)
            throw new ArgumentException("Channel names must be no longer than 256 characters.");

        return new Options(file, publisherUrl, id, label, latitudeChannel, longitudeChannel, database, speed);
    }

    private static (List<GpsFix> Fixes, string LatitudeChannel, string LongitudeChannel) DecodeMdf(Options options)
    {
        using var source = Mdf4File.Open(options.File);
        var locations = source.ChannelGroups
            .SelectMany((group, index) => group.Channels.Select(channel => new ChannelLocation(index, group, channel)))
            .ToList();

        var latitude = FindChannel(locations, options.LatitudeChannel, LatitudeNames, "latitude");
        var longitude = FindChannel(locations, options.LongitudeChannel, LongitudeNames, "longitude");
        if ((latitude is null || longitude is null) && options.Database is not null)
            return DecodeCanFrames(source, options);

        if (latitude is null || longitude is null)
        {
            var available = DescribeChannels(locations);
            throw new InvalidDataException(
                $"Latitude/longitude channels were not found. Available MDF4 channels: {available}. " +
                "Provide the matching DBC with --database if the file contains raw CAN GPS data.");
        }

        var latitudeTimes = latitude.Group.ReadTimestamps();
        var longitudeTimes = longitude.Group.ReadTimestamps();
        var latitudeValues = latitude.Channel.ReadDoubles();
        var longitudeValues = longitude.Channel.ReadDoubles();
        if (!latitudeTimes.SequenceEqual(longitudeTimes) || latitudeValues.Length != latitudeTimes.Length || longitudeValues.Length != latitudeTimes.Length)
            throw new InvalidDataException("Latitude and longitude channels have different timestamps; select channels sampled together before playback.");

        var validity = FindValidityChannel(locations, latitude.GroupIndex);
        double[]? validityTimes = null;
        object?[]? validityValues = null;
        if (validity is not null)
        {
            validityTimes = validity.Group.ReadTimestamps();
            validityValues = validity.Channel.ReadValues();
            if (!validityTimes.SequenceEqual(latitudeTimes))
                throw new InvalidDataException("The position-valid channel does not align with the coordinate timestamps.");
        }

        var fixes = new List<GpsFix>();
        for (var index = 0; index < latitudeTimes.Length; index++)
        {
            if (validityValues is not null && !IsValidFix(validityValues[index]))
                continue;

            var lat = latitudeValues[index];
            var lon = longitudeValues[index];
            if (!IsValidCoordinate(lat, lon))
                continue;
            fixes.Add(new GpsFix(lat, lon, source.StartTime.AddSeconds(latitudeTimes[index]), latitudeTimes[index]));
        }

        if (fixes.Count == 0)
            throw new InvalidDataException("The MDF4 file contains no valid GPS fixes.");
        return (fixes, latitude.Channel.Name, longitude.Channel.Name);
    }

    private static (List<GpsFix> Fixes, string LatitudeChannel, string LongitudeChannel) DecodeCanFrames(Mdf4File source, Options options)
    {
        var database = ParseDatabase(options.Database!);
        var signalNames = database.Values.SelectMany(message => message.Signals).Select(signal => signal.Name).Distinct(StringComparer.OrdinalIgnoreCase).ToList();
        var latitudeSignal = FindSignalName(signalNames, options.LatitudeChannel, LatitudeNames, "latitude");
        var longitudeSignal = FindSignalName(signalNames, options.LongitudeChannel, LongitudeNames, "longitude");
        if (latitudeSignal is null || longitudeSignal is null)
            throw new InvalidDataException($"The configured DBC has no latitude/longitude signals. Available DBC signals: {DescribeNames(signalNames)}.");

        var candidateMessages = database.Values
            .Where(message => message.Signals.Any(signal => string.Equals(signal.Name, latitudeSignal, StringComparison.OrdinalIgnoreCase)) &&
                              message.Signals.Any(signal => string.Equals(signal.Name, longitudeSignal, StringComparison.OrdinalIgnoreCase)))
            .ToDictionary(message => message.Id);
        if (candidateMessages.Count == 0)
            throw new InvalidDataException("Latitude and longitude DBC signals must belong to the same CAN message.");

        var fixes = new List<GpsFix>();
        foreach (var frame in CanBusLogging.ReadCanDataFrames(source))
        {
            if (!candidateMessages.TryGetValue(frame.Id, out var message))
                continue;

            var lat = DecodeSignal(message.Signals.First(signal => string.Equals(signal.Name, latitudeSignal, StringComparison.OrdinalIgnoreCase)), frame.Data.Span);
            var lon = DecodeSignal(message.Signals.First(signal => string.Equals(signal.Name, longitudeSignal, StringComparison.OrdinalIgnoreCase)), frame.Data.Span);
            var validity = message.Signals.FirstOrDefault(signal =>
                ValidityNames.Any(name => NormalizeName(signal.Name).StartsWith(name, StringComparison.Ordinal)));
            if (validity is not null && DecodeSignal(validity, frame.Data.Span) != 1)
                continue;
            if (!IsValidCoordinate(lat, lon))
                continue;
            fixes.Add(new GpsFix(lat, lon, source.StartTime.AddSeconds(frame.Timestamp), frame.Timestamp));
        }

        if (fixes.Count == 0)
            throw new InvalidDataException("The MDF4 file contains no valid GPS fixes decoded with the configured DBC.");
        return (fixes, latitudeSignal, longitudeSignal);
    }

    private static Dictionary<uint, DbcMessage> ParseDatabase(string path)
    {
        var messages = new Dictionary<uint, DbcMessage>();
        DbcMessageBuilder? current = null;
        var messagePattern = new Regex(@"^\s*BO_\s+(\d+)\s+\S+\s*:", RegexOptions.Compiled);
        var signalPattern = new Regex(
            @"^\s*SG_\s+([A-Za-z0-9_]+)(?:\s+[^:]+)?\s*:\s*(\d+)\|(\d+)@([01])([+-])\s*\(([-+0-9.eE]+),([-+0-9.eE]+)\)",
            RegexOptions.Compiled);

        foreach (var line in System.IO.File.ReadLines(path))
        {
            var messageMatch = messagePattern.Match(line);
            if (messageMatch.Success)
            {
                if (current is not null)
                    messages[current.Id] = current.Build();
                current = new DbcMessageBuilder(uint.Parse(messageMatch.Groups[1].Value, CultureInfo.InvariantCulture));
                continue;
            }

            var signalMatch = signalPattern.Match(line);
            if (!signalMatch.Success || current is null)
                continue;
            current.Signals.Add(new DbcSignal(
                signalMatch.Groups[1].Value,
                int.Parse(signalMatch.Groups[2].Value, CultureInfo.InvariantCulture),
                int.Parse(signalMatch.Groups[3].Value, CultureInfo.InvariantCulture),
                signalMatch.Groups[4].Value == "1",
                signalMatch.Groups[5].Value == "-",
                double.Parse(signalMatch.Groups[6].Value, CultureInfo.InvariantCulture),
                double.Parse(signalMatch.Groups[7].Value, CultureInfo.InvariantCulture)));
        }

        if (current is not null)
            messages[current.Id] = current.Build();
        if (messages.Count == 0)
            throw new InvalidDataException($"No CAN messages could be read from DBC file: {path}");
        return messages;
    }

    private sealed class DbcMessageBuilder(uint id)
    {
        public uint Id { get; } = id;
        public List<DbcSignal> Signals { get; } = [];
        public DbcMessage Build() => new(Id, Signals.ToArray());
    }

    private static double DecodeSignal(DbcSignal signal, ReadOnlySpan<byte> data)
    {
        if (signal.Length is < 1 or > 64)
            throw new InvalidDataException($"DBC signal {signal.Name} uses unsupported bit length {signal.Length}.");

        ulong raw = 0;
        for (var bit = 0; bit < signal.Length; bit++)
        {
            var sourceBit = signal.LittleEndian
                ? signal.StartBit + bit
                : NextMotorolaBit(signal.StartBit, bit);
            if (sourceBit < 0 || sourceBit >= data.Length * 8)
                throw new InvalidDataException($"DBC signal {signal.Name} exceeds the CAN frame data length.");
            var bitValue = (ulong)((data[sourceBit / 8] >> (sourceBit % 8)) & 1);
            if (signal.LittleEndian)
                raw |= (ulong)bitValue << bit;
            else
                raw = (raw << 1) | bitValue;
        }

        double value = raw;
        if (signal.Signed && signal.Length < 64 && (raw & (1UL << (signal.Length - 1))) != 0)
            value = (long)(raw | (ulong.MaxValue << signal.Length));
        else if (signal.Signed && signal.Length == 64)
            value = unchecked((long)raw);
        return value * signal.Factor + signal.Offset;
    }

    private static int NextMotorolaBit(int startBit, int offset)
    {
        var bit = startBit;
        for (var index = 0; index < offset; index++)
            bit = bit % 8 == 0 ? bit + 15 : bit - 1;
        return bit;
    }

    private static ChannelLocation? FindChannel(
        IReadOnlyList<ChannelLocation> locations,
        string? requested,
        IReadOnlyCollection<string> candidates,
        string purpose)
    {
        if (!string.IsNullOrWhiteSpace(requested))
        {
            var exact = locations.FirstOrDefault(location => string.Equals(location.Channel.Name, requested, StringComparison.OrdinalIgnoreCase));
            return exact ?? throw new InvalidDataException($"Could not find {purpose} channel '{requested}' in the MDF4 file.");
        }

        var normalizedCandidates = candidates.Select(NormalizeName).ToHashSet(StringComparer.Ordinal);
        return locations.FirstOrDefault(location => normalizedCandidates.Contains(NormalizeName(location.Channel.Name)))
            ?? locations.FirstOrDefault(location =>
            {
                var name = NormalizeName(location.Channel.Name);
                return !name.Contains("accuracy", StringComparison.Ordinal) &&
                       !name.Contains("valid", StringComparison.Ordinal) &&
                       normalizedCandidates.Any(candidate => name.StartsWith(candidate, StringComparison.Ordinal));
            });
    }

    private static ChannelLocation? FindValidityChannel(IReadOnlyList<ChannelLocation> locations, int groupIndex)
    {
        return locations.FirstOrDefault(location =>
                   location.GroupIndex == groupIndex && ValidityNames.Contains(NormalizeName(location.Channel.Name), StringComparer.Ordinal))
               ?? locations.FirstOrDefault(location =>
                   ValidityNames.Any(name => NormalizeName(location.Channel.Name).StartsWith(name, StringComparison.Ordinal)));
    }

    private static string? FindSignalName(
        IReadOnlyList<string> names,
        string? requested,
        IReadOnlyCollection<string> candidates,
        string purpose)
    {
        if (!string.IsNullOrWhiteSpace(requested))
            return names.FirstOrDefault(name => string.Equals(name, requested, StringComparison.OrdinalIgnoreCase))
                   ?? throw new InvalidDataException($"Could not find {purpose} signal '{requested}' in the DBC file.");

        var normalizedCandidates = candidates.Select(NormalizeName).ToHashSet(StringComparer.Ordinal);
        return names.FirstOrDefault(name => normalizedCandidates.Contains(NormalizeName(name)))
               ?? names.FirstOrDefault(name =>
               {
                   var normalized = NormalizeName(name);
                   return !normalized.Contains("accuracy", StringComparison.Ordinal) &&
                          !normalized.Contains("valid", StringComparison.Ordinal) &&
                          normalizedCandidates.Any(candidate => normalized.StartsWith(candidate, StringComparison.Ordinal));
               });
    }

    private static bool IsValidFix(object? value)
    {
        return value switch
        {
            bool boolean => boolean,
            string text => new[] { "valid", "true", "yes", "1" }.Contains(text.Trim(), StringComparer.OrdinalIgnoreCase),
            byte[] bytes => IsValidFix(Encoding.ASCII.GetString(bytes)),
            null => false,
            _ => TryConvertNumber(value, out var number) && number == 1
        };
    }

    private static bool TryConvertNumber(object value, out double number)
    {
        try
        {
            number = Convert.ToDouble(value, CultureInfo.InvariantCulture);
            return double.IsFinite(number);
        }
        catch (FormatException)
        {
            number = 0;
            return false;
        }
        catch (InvalidCastException)
        {
            number = 0;
            return false;
        }
    }

    private static bool IsValidCoordinate(double latitude, double longitude) =>
        double.IsFinite(latitude) && double.IsFinite(longitude) &&
        latitude is >= -90 and <= 90 && longitude is >= -180 and <= 180;

    private static string NormalizeName(string value) =>
        new(value.Where(char.IsLetterOrDigit).Select(char.ToLowerInvariant).ToArray());

    private static string DescribeChannels(IReadOnlyList<ChannelLocation> locations) =>
        DescribeNames(locations.Select(location => location.Channel.Name).Distinct(StringComparer.OrdinalIgnoreCase).Order(StringComparer.OrdinalIgnoreCase).ToList());

    private static string DescribeNames(IReadOnlyList<string> names)
    {
        if (names.Count == 0)
            return "none";
        var visible = names.Take(20).ToList();
        var description = string.Join(", ", visible);
        return names.Count > visible.Count ? $"{description}, and {names.Count - visible.Count} more" : description;
    }

    private static List<GpsFix> ReduceStraightLineFixes(IReadOnlyList<GpsFix> fixes)
    {
        if (fixes.Count <= 2)
            return fixes.ToList();

        var reduced = new List<GpsFix> { fixes[0] };
        var anchor = fixes[0];
        var previousCandidate = fixes[0];
        double? anchorBearing = null;

        for (var index = 1; index < fixes.Count - 1; index++)
        {
            var candidate = fixes[index];
            var bearing = BearingBetween(anchor, candidate);
            if (!double.IsFinite(bearing))
                continue;

            anchorBearing ??= bearing;
            if (BearingChange(anchorBearing.Value, bearing) >= DirectionChangeThresholdDegrees)
            {
                reduced.Add(previousCandidate);
                anchor = previousCandidate;
                bearing = BearingBetween(anchor, candidate);
                anchorBearing = double.IsFinite(bearing) ? bearing : null;
            }

            previousCandidate = candidate;
        }

        reduced.Add(fixes[^1]);
        return reduced;
    }

    private static double BearingBetween(GpsFix start, GpsFix end)
    {
        var startLatitude = DegreesToRadians(start.Latitude);
        var endLatitude = DegreesToRadians(end.Latitude);
        var longitudeDelta = DegreesToRadians(end.Longitude - start.Longitude);
        var y = Math.Sin(longitudeDelta) * Math.Cos(endLatitude);
        var x = Math.Cos(startLatitude) * Math.Sin(endLatitude)
            - Math.Sin(startLatitude) * Math.Cos(endLatitude) * Math.Cos(longitudeDelta);
        if (Math.Abs(x) + Math.Abs(y) < 1e-12)
            return double.NaN;
        return (Math.Atan2(y, x) * 180 / Math.PI + 360) % 360;
    }

    private static double DegreesToRadians(double degrees) => degrees * Math.PI / 180;

    private static double BearingChange(double first, double second) =>
        Math.Abs((second - first + 540) % 360 - 180);

    private static async Task PublishFixesAsync(IReadOnlyList<GpsFix> fixes, Options options)
    {
        var trackStartUri = GetTrackStartUri(options.PublisherUrl);
        await PostJsonAsync(trackStartUri, new TrackStart(
            "track-start",
            options.Id,
            options.Label,
            new Coordinate(fixes[0].Latitude, fixes[0].Longitude),
            new Coordinate(fixes[^1].Latitude, fixes[^1].Longitude)), "track bounds");

        double? previousElapsed = null;
        for (var index = 0; index < fixes.Count; index++)
        {
            var fix = fixes[index];
            if (previousElapsed.HasValue && options.Speed > 0)
            {
                var delaySeconds = Math.Max(0, fix.Elapsed - previousElapsed.Value) / options.Speed;
                await Task.Delay(TimeSpan.FromSeconds(delaySeconds));
            }
            previousElapsed = fix.Elapsed;

            await PostJsonAsync(
                new Uri(options.PublisherUrl),
                new PublishedFix(options.Id, options.Label, fix.Latitude, fix.Longitude, fix.Timestamp),
                $"GPS fix {index + 1}");
            if ((index + 1) % 100 == 0)
                Console.Error.WriteLine($"Published {index + 1}/{fixes.Count} GPS fixes");
        }
    }

    private static Uri GetTrackStartUri(string publisherUrl)
    {
        var uri = new Uri(publisherUrl);
        var slash = uri.AbsolutePath.LastIndexOf('/');
        var builder = new UriBuilder(uri) { Path = uri.AbsolutePath[..(slash + 1)] + "track-start" };
        return builder.Uri;
    }

    private static async Task PostJsonAsync(Uri uri, object payload, string description)
    {
        using var response = await HttpClient.PostAsJsonAsync(uri, payload, JsonOptions);
        if (!response.IsSuccessStatusCode)
        {
            var detail = await response.Content.ReadAsStringAsync();
            throw new HttpRequestException($"Publisher rejected {description}: {(int)response.StatusCode} {detail}".Trim());
        }
    }
}
