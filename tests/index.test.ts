import { describe, expect, it } from "vitest";
import { SLOT_DEFINITION_VERSION } from "@cyanmycelium/mcp-open-api";

describe("package entry", () => {
    it("names the slot definition format it targets", () => {
        expect(SLOT_DEFINITION_VERSION).toBe(1);
    });
});
