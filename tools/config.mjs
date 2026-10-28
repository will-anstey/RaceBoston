// Shared map configuration for the data tools.

// Drivable / fully-detailed area: Back Bay, Fenway, Downtown, North End,
// Beacon Hill, South End, Seaport, South Boston, Charlestown, and east Cambridge.
export const PLAY_BBOX = { south: 42.332, west: -71.115, north: 42.385, east: -71.025 };

// Larger area for water, coastline and parks so the horizon looks right.
export const WATER_BBOX = { south: 42.314, west: -71.14, north: 42.403, east: -71.0 };

// Projection origin (roughly Boston Common). World units are meters:
// +x = east, +z = south, +y = up.
export const ORIGIN = { lat: 42.3555, lon: -71.0655 };
