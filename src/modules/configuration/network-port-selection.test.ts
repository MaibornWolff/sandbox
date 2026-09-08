import { describe, expect, test } from "bun:test";
import {
  ALL_NETWORK_PORTS,
  allowsAllNetworkPorts,
  formatNetworkPortSelection,
  getExplicitNetworkPorts,
  isNetworkPortSelection,
  mergeNetworkPortSelections,
  networkPortSelectionIncludes,
} from "./network-port-selection.js";

describe("network port selection", () => {
  test("validates explicit and all-port selections", () => {
    expect(isNetworkPortSelection([1, 443, 65_535])).toBe(true);
    expect(isNetworkPortSelection(ALL_NETWORK_PORTS)).toBe(true);
    expect(isNetworkPortSelection([443, ALL_NETWORK_PORTS])).toBe(false);
    expect(isNetworkPortSelection([0, 65_536])).toBe(false);
  });

  test("merges explicit ports and gives all ports precedence", () => {
    expect(mergeNetworkPortSelections([443, 22], [443, 80])).toEqual([
      22, 80, 443,
    ]);
    expect(mergeNetworkPortSelections([443], ALL_NETWORK_PORTS)).toBe(
      ALL_NETWORK_PORTS,
    );
  });

  test("exposes common selection operations", () => {
    expect(allowsAllNetworkPorts(ALL_NETWORK_PORTS)).toBe(true);
    expect(getExplicitNetworkPorts(ALL_NETWORK_PORTS)).toEqual([]);
    expect(networkPortSelectionIncludes(ALL_NETWORK_PORTS, 8443)).toBe(true);
    expect(networkPortSelectionIncludes([443], 8443)).toBe(false);
    expect(
      formatNetworkPortSelection([443, 22, 443], {
        allPorts: "1-65535",
        separator: " ",
      }),
    ).toBe("22 443");
    expect(
      formatNetworkPortSelection(ALL_NETWORK_PORTS, {
        allPorts: "1-65535",
        separator: " ",
      }),
    ).toBe("1-65535");
  });
});
