import { beforeEach, describe, expect, test } from "bun:test";
import { goBack, navigateTo, navigationSummary, readState, registerAgentJetState, setOptions } from "../src/handles";

type Nav = {
	navigate: (name: string, params?: unknown) => void;
	goBack: () => void;
	canGoBack: () => boolean;
	getRootState: () => unknown;
	getCurrentRoute: () => { name: string } | undefined;
};

/** A React Navigation container shaped like NEAT's: a stack whose first route holds the tabs. */
function reactNavigation(overrides: Partial<Nav> = {}) {
	const calls: Array<{ name: string; params?: unknown }> = [];
	const nav: Nav = {
		navigate: (name, params) => calls.push({ name, params }),
		goBack: () => calls.push({ name: "__back__" }),
		canGoBack: () => true,
		getCurrentRoute: () => ({ name: "For You" }),
		getRootState: () => ({
			type: "stack",
			index: 0,
			routes: [
				{
					name: "Tab",
					state: {
						type: "tab",
						index: 0,
						routes: [
							{ name: "Landing", state: { type: "tab", index: 0, routes: [{ name: "For You" }] } },
							{ name: "Search" },
						],
					},
				},
				{ name: "PostDetail" },
			],
		}),
		...overrides,
	};
	return { nav, calls };
}

beforeEach(() => setOptions({}));

describe("navigateTo with React Navigation", () => {
	test("resolves a nested route to its full path so it works from any screen", () => {
		const { nav, calls } = reactNavigation();
		setOptions({ navigationRef: nav });
		navigateTo("Search");
		// Search lives under Tab, so navigating to the bare name must go through Tab
		expect(calls[0]).toEqual({ name: "Tab", params: { screen: "Search", params: undefined } });
	});

	test("navigates directly to a top-level route", () => {
		const { nav, calls } = reactNavigation();
		setOptions({ navigationRef: nav });
		navigateTo("PostDetail", { id: 1 });
		expect(calls[0]).toEqual({ name: "PostDetail", params: { id: 1 } });
	});

	test("passes an unknown route straight through rather than guessing", () => {
		const { nav, calls } = reactNavigation();
		setOptions({ navigationRef: nav });
		navigateTo("Unknown");
		expect(calls[0]!.name).toBe("Unknown");
	});

	test("accepts a ref object as well as the container itself", () => {
		const { nav, calls } = reactNavigation();
		setOptions({ navigationRef: { current: nav } });
		navigateTo("Search");
		expect(calls).toHaveLength(1);
	});

	test("explains itself when the container is not mounted yet", () => {
		setOptions({ navigationRef: { current: null } });
		expect(() => navigateTo("Search")).toThrow(/not mounted/);
	});

	test("explains itself when no navigation was provided", () => {
		expect(() => navigateTo("Search")).toThrow(/No navigationRef/);
	});
});

describe("navigateTo with Expo Router", () => {
	test("a path goes to the router, not React Navigation", () => {
		const pushed: string[] = [];
		const { nav, calls } = reactNavigation();
		setOptions({
			navigationRef: nav,
			router: {
				navigate: (href) => pushed.push(href),
				push: () => {},
				replace: () => {},
				back: () => {},
				canGoBack: () => true,
			},
		});
		navigateTo("/detail/42");
		expect(pushed).toEqual(["/detail/42"]);
		expect(calls).toHaveLength(0);
	});

	test("a bare route name still uses React Navigation when both are present", () => {
		const pushed: string[] = [];
		const { nav, calls } = reactNavigation();
		setOptions({
			navigationRef: nav,
			router: {
				navigate: (href) => pushed.push(href),
				push: () => {},
				replace: () => {},
				back: () => {},
				canGoBack: () => true,
			},
		});
		navigateTo("Search");
		expect(pushed).toHaveLength(0);
		expect(calls).toHaveLength(1);
	});
});

describe("goBack", () => {
	test("refuses when there is nowhere to go", () => {
		const { nav } = reactNavigation({ canGoBack: () => false });
		setOptions({ navigationRef: nav });
		expect(() => goBack()).toThrow(/Cannot go back/);
	});

	test("goes back when it can", () => {
		const { nav, calls } = reactNavigation();
		setOptions({ navigationRef: nav });
		goBack();
		expect(calls[0]!.name).toBe("__back__");
	});
});

describe("navigationSummary", () => {
	test("reports the focused path through the nested navigators", () => {
		const { nav } = reactNavigation();
		setOptions({ navigationRef: nav });
		const summary = navigationSummary() as { path: string[] };
		expect(summary.path).toEqual(["Tab", "Landing", "For You"]);
	});
});

describe("state", () => {
	test("reads values registered from outside React", () => {
		const unregister = registerAgentJetState("session", () => ({ userId: 7 }));
		expect(readState("session")).toEqual({ session: { userId: 7 } });
		unregister();
		expect(() => readState("session")).toThrow(/Unknown state key/);
	});

	test("summarises the query cache without leaking the data itself", () => {
		setOptions({
			queryClient: {
				getQueryCache: () => ({
					getAll: () => [
						{ queryKey: ["posts"], state: { status: "success", dataUpdatedAt: 5, error: null, fetchStatus: "idle" } },
					],
				}),
			},
		});
		const queries = (readState("queries") as { queries: Array<{ key: unknown; status: string }> }).queries;
		expect(queries[0]).toMatchObject({ key: ["posts"], status: "success" });
	});

	test("a throwing getter is reported instead of breaking the whole read", () => {
		registerAgentJetState("boom", () => {
			throw new Error("nope");
		});
		expect(readState()).toMatchObject({ boom: { error: "nope" } });
	});

	test("lists the known keys when asked for one that does not exist", () => {
		registerAgentJetState("cart", () => 1);
		expect(() => readState("nope")).toThrow(/cart/);
	});
});
