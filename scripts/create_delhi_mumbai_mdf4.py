import argparse
import json
import math
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import numpy as np
from asammdf import MDF, Signal


# Approximate control points along the Delhi-Mumbai Expressway corridor.
# Use --route-geojson with surveyed road geometry for an exact road trace.
DELHI_MUMBAI_ROUTE = [
    (28.5000, 77.3080),  # Delhi / DND-Faridabad link
    (28.3860, 77.1900),  # Faridabad
    (28.2480, 77.0660),  # Sohna
    (28.1060, 77.0060),  # Nuh
    (27.8160, 76.8300),  # Haryana-Rajasthan border
    (27.3600, 76.5840),  # Alwar district
    (26.9000, 76.3420),  # Dausa
    (26.4900, 76.3230),  # Lalsot
    (25.8700, 76.2500),  # Sawai Madhopur district
    (25.3000, 75.9800),  # Kota district
    (24.8000, 75.9200),  # Rajasthan-Madhya Pradesh corridor
    (24.3000, 75.4500),  # Jhalawar district
    (23.9200, 75.1800),  # Madhya Pradesh
    (23.4700, 75.1000),  # Ratlam district
    (23.0500, 74.7200),  # Madhya Pradesh-Gujarat corridor
    (22.8200, 74.2800),  # Dahod
    (22.7300, 73.7400),  # Godhra
    (22.4300, 73.4200),  # Vadodara district
    (22.2700, 73.1200),  # Vadodara
    (21.9100, 73.0100),  # Bharuch district
    (21.6100, 72.9800),  # Bharuch
    (21.3000, 72.8900),  # Surat district
    (21.0500, 72.9200),  # Surat
    (20.7200, 72.9400),  # Navsari district
    (20.3800, 72.9200),  # Valsad district
    (20.0000, 72.8400),  # Gujarat-Maharashtra corridor
    (19.6500, 72.8000),  # Palghar district
    (19.3000, 72.8500),  # Mumbai region
    (18.9500, 72.9500),  # JNPT / Navi Mumbai
]


def load_route(route_file: Path | None) -> list[tuple[float, float]]:
    if route_file is None:
        return DELHI_MUMBAI_ROUTE.copy()

    with route_file.open(encoding="utf-8") as file:
        data: Any = json.load(file)
    if data.get("type") == "Feature":
        data = data.get("geometry")
    if not isinstance(data, dict) or data.get("type") != "LineString":
        raise ValueError("Route GeoJSON must be a LineString or a Feature containing a LineString.")

    coordinates = data.get("coordinates")
    if not isinstance(coordinates, list) or len(coordinates) < 2:
        raise ValueError("Route GeoJSON must contain at least two coordinates.")

    route: list[tuple[float, float]] = []
    for index, coordinate in enumerate(coordinates, start=1):
        if not isinstance(coordinate, list) or len(coordinate) < 2:
            raise ValueError(f"Invalid GeoJSON coordinate at index {index}.")
        longitude, latitude = float(coordinate[0]), float(coordinate[1])
        if not math.isfinite(latitude) or not -90 <= latitude <= 90:
            raise ValueError(f"Invalid latitude at GeoJSON coordinate {index}.")
        if not math.isfinite(longitude) or not -180 <= longitude <= 180:
            raise ValueError(f"Invalid longitude at GeoJSON coordinate {index}.")
        route.append((latitude, longitude))
    return route


def haversine_meters(first: tuple[float, float], second: tuple[float, float]) -> float:
    latitude1, longitude1 = map(math.radians, first)
    latitude2, longitude2 = map(math.radians, second)
    latitude_delta = latitude2 - latitude1
    longitude_delta = longitude2 - longitude1
    haversine = (
        math.sin(latitude_delta / 2) ** 2
        + math.cos(latitude1) * math.cos(latitude2) * math.sin(longitude_delta / 2) ** 2
    )
    return 2 * 6_371_000 * math.asin(math.sqrt(haversine))


def densify_route(
    route: list[tuple[float, float]], spacing_meters: float
) -> list[tuple[float, float]]:
    points = [route[0]]
    for start, end in zip(route, route[1:]):
        distance = haversine_meters(start, end)
        segments = max(1, math.ceil(distance / spacing_meters))
        for segment in range(1, segments + 1):
            ratio = segment / segments
            points.append(
                (
                    start[0] + (end[0] - start[0]) * ratio,
                    start[1] + (end[1] - start[1]) * ratio,
                )
            )
    return points


def write_mdf4(
    output: Path,
    points: list[tuple[float, float]],
    sample_interval: float,
) -> None:
    timestamps = np.arange(len(points), dtype=np.float64) * sample_interval
    latitude = np.array([point[0] for point in points], dtype=np.float64)
    longitude = np.array([point[1] for point in points], dtype=np.float64)
    validity = np.ones(len(points), dtype=np.uint8)

    mdf = MDF(version="4.10")
    try:
        mdf.start_time = datetime.now(timezone.utc)
        mdf.append(
            [
                Signal(
                    samples=latitude,
                    timestamps=timestamps,
                    name="Latitude",
                    unit="deg",
                    comment="Synthetic Delhi-Mumbai Expressway sample latitude",
                ),
                Signal(
                    samples=longitude,
                    timestamps=timestamps,
                    name="Longitude",
                    unit="deg",
                    comment="Synthetic Delhi-Mumbai Expressway sample longitude",
                ),
                Signal(
                    samples=validity,
                    timestamps=timestamps,
                    name="PositionValid",
                    comment="1 indicates a valid synthetic position",
                ),
            ],
            acq_name="Delhi-Mumbai Expressway GPS",
            comment="Synthetic GPS demonstration track; not surveyed vehicle data.",
            common_timebase=True,
        )
        output.parent.mkdir(parents=True, exist_ok=True)
        mdf.save(output, overwrite=True)
    finally:
        mdf.close()


def main() -> int:
    project_root = Path(__file__).resolve().parents[1]
    parser = argparse.ArgumentParser(
        description="Create an MDF4 GPS demo track for the Delhi-Mumbai Expressway (NE-4)."
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=project_root / "server" / "data" / "delhi-mumbai-expressway-demo.mf4",
        help="Output MDF4 file",
    )
    parser.add_argument(
        "--route-geojson",
        type=Path,
        help="Optional precise road route as a GeoJSON LineString (coordinates are [longitude, latitude])",
    )
    parser.add_argument(
        "--spacing-meters",
        type=float,
        default=500,
        help="Approximate distance between generated samples (default: 500 m)",
    )
    parser.add_argument(
        "--sample-interval",
        type=float,
        default=0.2,
        help="Time between samples in seconds (default: 0.2)",
    )
    args = parser.parse_args()

    if not math.isfinite(args.spacing_meters) or args.spacing_meters <= 0:
        parser.error("--spacing-meters must be a positive number")
    if not math.isfinite(args.sample_interval) or args.sample_interval <= 0:
        parser.error("--sample-interval must be a positive number")
    if args.route_geojson and not args.route_geojson.is_file():
        parser.error(f"Route GeoJSON does not exist: {args.route_geojson}")

    route = load_route(args.route_geojson)
    points = densify_route(route, args.spacing_meters)
    write_mdf4(args.output, points, args.sample_interval)

    distance_km = sum(haversine_meters(first, second) for first, second in zip(route, route[1:])) / 1000
    print(
        f"Created {args.output} with {len(points)} GPS samples "
        f"({distance_km:.1f} km approximate route, "
        f"{points[0][0]:.5f},{points[0][1]:.5f} to {points[-1][0]:.5f},{points[-1][1]:.5f})."
    )
    print("Latitude/longitude samples are synthetic and follow an approximate corridor, not surveyed road geometry.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
