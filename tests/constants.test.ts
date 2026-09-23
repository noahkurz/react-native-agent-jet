import { afterEach, describe, expect, test } from "bun:test";
import { configuredPort, DEFAULT_PORT, PORT_ENV } from "../src/constants";

afterEach(() => {
	delete process.env[PORT_ENV];
});

describe("the port the bridge dials", () => {
	test("is the default when the environment says nothing", () => {
		expect(configuredPort()).toBe(DEFAULT_PORT);
	});

	test("follows EXPO_PUBLIC_AGENT_JET_PORT, so a second app needs no source edit", () => {
		process.env[PORT_ENV] = "8766";
		expect(configuredPort()).toBe(8766);
	});

	test("ignores a value that is not a usable port rather than dialing NaN", () => {
		for (const nonsense of ["", "no", "0", "-1", "65.5"]) {
			process.env[PORT_ENV] = nonsense;
			expect(configuredPort()).toBe(DEFAULT_PORT);
		}
	});
});
