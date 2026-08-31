import { describe, expect, it } from "vitest";
import {
  selectInitialWorkspaceRegion,
  selectNearestWorkspaceRegion,
  type WorkspaceRegionCandidate,
} from "./placement.js";

const regions: readonly WorkspaceRegionCandidate[] = [
  {
    regionId: "in-south",
    displayName: "India South",
    latitude: 19.076,
    longitude: 72.8777,
  },
  {
    regionId: "us-east",
    displayName: "US East",
    latitude: 39.0438,
    longitude: -77.4874,
  },
  {
    regionId: "eu-west",
    displayName: "Europe West",
    latitude: 53.3498,
    longitude: -6.2603,
  },
];

describe("workspace region placement", () => {
  it.each([
    ["Mumbai", 19.076, 72.8777, "in-south"],
    ["New York", 40.7128, -74.006, "us-east"],
    ["Paris", 48.8566, 2.3522, "eu-west"],
  ])(
    "selects the nearest cell for %s edge coordinates",
    (_, latitude, longitude, expected) => {
      expect(selectNearestWorkspaceRegion({ latitude, longitude }, regions)).toBe(
        expected,
      );
    },
  );

  it.each([
    ["AS", "in-south"],
    ["EU", "eu-west"],
    ["NA", "us-east"],
  ])(
    "uses the %s continent center when coordinates are unavailable",
    (continent, expected) => {
      expect(selectNearestWorkspaceRegion({ continent }, regions)).toBe(expected);
    },
  );

  it("returns no recommendation without trusted location or located cells", () => {
    expect(selectNearestWorkspaceRegion(null, regions)).toBeNull();
    expect(
      selectNearestWorkspaceRegion({ latitude: 19.076, longitude: 72.8777 }, [
        { regionId: "unlocated", displayName: "Unlocated" },
      ]),
    ).toBeNull();
  });

  it("uses a valid latency recommendation before the stable fallback", () => {
    expect(
      selectInitialWorkspaceRegion(
        "user:stable",
        regions.map((region) => region.regionId),
        "in-south",
      ),
    ).toBe("in-south");
    expect(
      selectInitialWorkspaceRegion(
        "user:stable",
        regions.map((region) => region.regionId),
        "not-declared",
      ),
    ).toBe(
      selectInitialWorkspaceRegion(
        "user:stable",
        regions.map((region) => region.regionId),
      ),
    );
  });
});
