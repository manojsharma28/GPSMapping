import argparse
import json
import math
import sys
import time
from datetime import timedelta
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

try:
    from asammdf import MDF
except ModuleNotFoundError as error:
    if error.name != "asammdf":
        raise
    print(
        f"MDF4 support is not installed for {sys.executable}. "
        "Install it with: python -m pip install -r requirements-mdf4.txt",
        file=sys.stderr,
    )
    raise SystemExit(1) from error


LATITUDE_NAMES = ("latitude", "lat", "gpslatitude", "gpslat")
LONGITUDE_NAMES = ("longitude", "lon", "lng", "gpslongitude", "gpslon", "gpslng")
VALIDITY_NAMES = ("positionvalid", "gpsvalid", "locationvalid")


def normalize_name(value: str) -> str:
    return "".join(character for character in value.casefold() if character.isalnum())


def channel_locations(mdf: MDF) -> list[tuple[int, str]]:
    return [
        (group_index, channel.name)
        for group_index, group in enumerate(mdf.groups)
        for channel in group.channels
    ]


def describe_channels(mdf: MDF) -> str:
    names = sorted({name for _, name in channel_locations(mdf)})
    if not names:
        return "none"
    visible_names = names[:20]
    description = ", ".join(visible_names)
    if len(names) > len(visible_names):
        description += f", and {len(names) - len(visible_names)} more"
    return description


def find_channel(
    mdf: MDF,
    requested: str | None,
    candidates: tuple[str, ...],
    purpose: str,
) -> tuple[int, str] | None:
    locations = channel_locations(mdf)
    if requested:
        match = next(
            (location for location in locations if location[1].casefold() == requested.casefold()),
            None,
        )
        if match is None:
            raise ValueError(f"Could not find {purpose} channel {requested!r} in the MDF4 file")
        return match

    normalized_candidates = {normalize_name(candidate) for candidate in candidates}
    for group_index, name in locations:
        if normalize_name(name) in normalized_candidates:
            return group_index, name
    for group_index, name in locations:
        normalized = normalize_name(name)
        if "accuracy" not in normalized and "valid" not in normalized and any(
            normalized.startswith(candidate) for candidate in normalized_candidates
        ):
            return group_index, name
    return None


def find_validity_channel(mdf: MDF, group_index: int) -> tuple[int, str] | None:
    locations = channel_locations(mdf)
    preferred = [
        location
        for location in locations
        if location[0] == group_index and normalize_name(location[1]) in VALIDITY_NAMES
    ]
    if preferred:
        return preferred[0]
    return next(
        (
            location
            for location in locations
            if any(normalize_name(location[1]).startswith(name) for name in VALIDITY_NAMES)
        ),
        None,
    )


def read_signal(mdf: MDF, location: tuple[int, str]):
    return mdf.get(location[1], group=location[0])


def is_valid_fix(value: object) -> bool:
    if hasattr(value, "item"):
        value = value.item()
    if isinstance(value, bytes):
        value = value.decode("ascii", errors="ignore")
    if isinstance(value, str):
        return value.strip().casefold() in {"valid", "true", "yes", "1"}
    if isinstance(value, (bool, int, float)):
        return value == 1
    return False


def decode_mdf(args: argparse.Namespace) -> tuple[list[dict[str, object]], str, str]:
    source = MDF(args.file)
    decoded = None
    try:
        latitude_location = find_channel(source, args.latitude_channel, LATITUDE_NAMES, "latitude")
        longitude_location = find_channel(source, args.longitude_channel, LONGITUDE_NAMES, "longitude")

        if latitude_location is None or longitude_location is None:
            if args.database is None:
                raise ValueError(
                    "Latitude/longitude channels were not found. "
                    f"Available MDF4 channels: {describe_channels(source)}. "
                    "Provide the matching DBC with --database if the file contains raw CAN GPS data."
                )
            decoded = source.extract_bus_logging(database_files={"CAN": [(args.database, 0)]})
            mdf = decoded
            latitude_location = find_channel(mdf, args.latitude_channel, LATITUDE_NAMES, "latitude")
            longitude_location = find_channel(mdf, args.longitude_channel, LONGITUDE_NAMES, "longitude")
        else:
            mdf = source

        if latitude_location is None or longitude_location is None:
            available_channels = describe_channels(mdf)
            if mdf is not source and not channel_locations(mdf):
                raise ValueError(
                    "No latitude/longitude channels were found. "
                    f"The uploaded MDF4 contains: {describe_channels(source)}. "
                    "The configured DBC decoded no signals; use a log that contains GPS data "
                    "or provide the matching DBC."
                )
            raise ValueError(
                "Could not find latitude/longitude channels. "
                f"Available MDF4 channels: {available_channels}. "
                "Select the correct coordinate channel names or provide the matching DBC."
            )

        latitude_signal = read_signal(mdf, latitude_location)
        longitude_signal = read_signal(mdf, longitude_location)
        latitude_times = latitude_signal.timestamps.tolist()
        longitude_times = longitude_signal.timestamps.tolist()
        if latitude_times != longitude_times:
            raise ValueError(
                "Latitude and longitude channels have different timestamps; select channels sampled "
                "together before playback."
            )

        validity_location = find_validity_channel(mdf, latitude_location[0])
        validity_signal = read_signal(mdf, validity_location) if validity_location else None
        if validity_signal is not None and validity_signal.timestamps.tolist() != latitude_times:
            raise ValueError("The position-valid channel does not align with the coordinate timestamps.")

        start_time = mdf.start_time
        fixes: list[dict[str, object]] = []
        for index, (elapsed, latitude_value, longitude_value) in enumerate(
            zip(latitude_times, latitude_signal.samples.tolist(), longitude_signal.samples.tolist(), strict=True)
        ):
            if validity_signal is not None and not is_valid_fix(validity_signal.samples[index]):
                continue
            latitude = float(latitude_value)
            longitude = float(longitude_value)
            if (
                not math.isfinite(latitude)
                or not math.isfinite(longitude)
                or not -90 <= latitude <= 90
                or not -180 <= longitude <= 180
            ):
                continue
            fixes.append(
                {
                    "latitude": latitude,
                    "longitude": longitude,
                    "timestamp": (start_time + timedelta(seconds=float(elapsed))).isoformat(),
                    "_elapsed": float(elapsed),
                }
            )

        if not fixes:
            raise ValueError("The MDF4 file contains no valid GPS fixes.")
        return fixes, latitude_location[1], longitude_location[1]
    finally:
        if decoded is not None:
            decoded.close()
        source.close()


def publish_fixes(
    fixes: list[dict[str, object]],
    publisher_url: str,
    device_id: str,
    label: str | None,
    playback_speed: float,
) -> None:
    track_start = {
        "type": "track-start",
        "id": device_id,
        "label": label,
        "start": {
            "latitude": fixes[0]["latitude"],
            "longitude": fixes[0]["longitude"],
        },
        "end": {
            "latitude": fixes[-1]["latitude"],
            "longitude": fixes[-1]["longitude"],
        },
    }
    track_start_url = f"{publisher_url.rsplit('/', 1)[0]}/track-start"
    request = Request(
        track_start_url,
        data=json.dumps(track_start).encode("utf-8"),
        headers={"content-type": "application/json"},
        method="POST",
    )
    try:
        with urlopen(request, timeout=15) as response:
            if response.status < 200 or response.status >= 300:
                raise RuntimeError(f"Publisher returned HTTP {response.status} for track bounds")
    except HTTPError as error:
        detail = error.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"Publisher rejected track bounds: {detail}") from error
    except URLError as error:
        raise RuntimeError(f"Could not send track bounds to the publisher: {error.reason}") from error

    previous_elapsed: float | None = None
    for index, fix in enumerate(fixes, start=1):
        elapsed = float(fix.pop("_elapsed"))
        if previous_elapsed is not None and playback_speed > 0:
            time.sleep(max(0.0, elapsed - previous_elapsed) / playback_speed)
        previous_elapsed = elapsed

        payload = {
            "id": device_id,
            "label": label,
            **fix,
        }
        request = Request(
            publisher_url,
            data=json.dumps(payload).encode("utf-8"),
            headers={"content-type": "application/json"},
            method="POST",
        )
        try:
            with urlopen(request, timeout=15) as response:
                if response.status < 200 or response.status >= 300:
                    raise RuntimeError(f"Publisher returned HTTP {response.status}")
        except HTTPError as error:
            detail = error.read().decode("utf-8", errors="replace")
            raise RuntimeError(f"Publisher rejected GPS fix {index}: {detail}") from error
        except URLError as error:
            raise RuntimeError(f"Could not reach the ZeroMQ publisher: {error.reason}") from error

        if index % 100 == 0:
            print(f"Published {index}/{len(fixes)} GPS fixes", file=sys.stderr, flush=True)


def main() -> int:
    parser = argparse.ArgumentParser(description="Play GPS coordinates from an MDF4 file into the GPS publisher.")
    parser.add_argument("file", type=Path, help="Input MDF4 file")
    parser.add_argument("--database", type=Path, help="Optional DBC file for decoding raw CAN measurements")
    parser.add_argument("--latitude-channel", help="Latitude channel name (auto-detected if omitted)")
    parser.add_argument("--longitude-channel", help="Longitude channel name (auto-detected if omitted)")
    parser.add_argument("--id", default="mdf4-track", help="Device ID shown in the map")
    parser.add_argument("--label", help="Optional device label shown in the map")
    parser.add_argument("--publisher-url", required=True, help="Local coordinate publisher HTTP endpoint")
    parser.add_argument("--speed", type=float, default=10.0, help="Playback speed multiplier; 0 sends as fast as possible")
    args = parser.parse_args()

    if args.speed < 0 or args.speed > 1000 or not math.isfinite(args.speed):
        parser.error("--speed must be between 0 and 1000")
    if not args.file.is_file():
        parser.error(f"MDF4 file does not exist: {args.file}")
    if args.database is not None and not args.database.is_file():
        parser.error(f"DBC file does not exist: {args.database}")

    try:
        fixes, latitude_channel, longitude_channel = decode_mdf(args)
        publish_fixes(fixes, args.publisher_url, args.id, args.label, args.speed)
    except Exception as error:
        print(f"MDF4 playback failed: {error}", file=sys.stderr)
        return 1

    print(
        json.dumps(
            {
                "status": "published",
                "id": args.id,
                "points": len(fixes),
                "latitudeChannel": latitude_channel,
                "longitudeChannel": longitude_channel,
            }
        ),
        flush=True,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
