export type NavigationLike = {
	navigate(name: string, params?: Record<string, unknown>): void;
	goBack(): void;
	canGoBack(): boolean;
	getRootState(): unknown;
	getCurrentRoute(): { name: string; params?: unknown } | undefined;
};

export type NavigationHandle = NavigationLike | { current: NavigationLike | null };

export type QueryClientLike = {
	getQueryCache(): {
		getAll(): Array<{
			queryKey: unknown;
			state: { status: string; dataUpdatedAt: number; error: unknown; fetchStatus?: string };
		}>;
	};
};

import { configureRedaction, type RedactOption } from "./redact";

export type StateValue = unknown | (() => unknown);

export type ExpoRouterLike = {
	navigate(href: string): void;
	push(href: string): void;
	replace(href: string): void;
	back(): void;
	canGoBack(): boolean;
};

export type AgentJetOptions = {
	/** Redact secrets from captured logs and network bodies. Default true; false disables. */
	redact?: RedactOption;
	url?: string;
	appName?: string;
	navigationRef?: NavigationHandle;
	router?: ExpoRouterLike;
	queryClient?: QueryClientLike;
	state?: Record<string, StateValue>;
};

type Shared = { options: AgentJetOptions; registry: Map<string, () => unknown> };

const shared: Shared = ((globalThis as { __reactNativeAgentJetHandles?: Shared }).__reactNativeAgentJetHandles ??= {
	options: {},
	registry: new Map(),
});

export function setOptions(next: AgentJetOptions) {
	shared.options = next;
	configureRedaction(next.redact);
}

export function registerAgentJetState(key: string, value: StateValue): () => void {
	shared.registry.set(key, typeof value === "function" ? (value as () => unknown) : () => value);
	return () => {
		shared.registry.delete(key);
	};
}

function navigationOrNull(): NavigationLike | null {
	const handle = shared.options.navigationRef;
	if (!handle) return null;
	return "current" in handle ? handle.current : handle;
}

export function navigation(): NavigationLike {
	const handle = shared.options.navigationRef;
	if (!handle) throw new Error("No navigationRef registered; pass it to useAgentJet() or startAgentJet()");
	const nav = navigationOrNull();
	if (!nav) {
		throw new Error(
			"navigationRef.current is null: the NavigationContainer is not mounted. Either the app is still starting, or it crashed and React unmounted the tree; check logs and tree.",
		);
	}
	return nav;
}

function router(): ExpoRouterLike | undefined {
	return shared.options.router;
}

type RouteState = {
	type?: string;
	index?: number;
	routes: Array<{ name: string; params?: unknown; state?: RouteState }>;
};

function chainToRoute(state: RouteState | undefined, name: string): string[] | null {
	if (!state) return null;
	for (const route of state.routes) {
		if (route.name === name) return [name];
		const deeper = chainToRoute(route.state, name);
		if (deeper) return [route.name, ...deeper];
	}
	return null;
}

function nestedParams(chain: string[], params?: Record<string, unknown>): Record<string, unknown> | undefined {
	if (chain.length === 0) return params;
	const [head, ...rest] = chain;
	return { screen: head, params: nestedParams(rest, params) };
}

function looksLikePath(name: string): boolean {
	return name.startsWith("/") || name.startsWith(".") || name.includes("?");
}

export function navigateTo(name: string, params?: Record<string, unknown>): { route?: string } {
	const expo = router();
	if (expo && (looksLikePath(name) || !shared.options.navigationRef)) {
		expo.navigate(name);
		return { route: currentRouteName() };
	}
	const nav = navigation();
	const chain = chainToRoute(nav.getRootState() as RouteState | undefined, name);
	if (chain && chain.length > 1) {
		nav.navigate(chain[0]!, nestedParams(chain.slice(1), params));
	} else {
		nav.navigate(name, params);
	}
	return { route: nav.getCurrentRoute()?.name };
}

export function goBack(): { route?: string } {
	const nav = navigationOrNull();
	const expo = router();
	if (nav) {
		if (!nav.canGoBack()) throw new Error("Cannot go back from the current route");
		nav.goBack();
		return { route: nav.getCurrentRoute()?.name };
	}
	if (expo) {
		if (!expo.canGoBack()) throw new Error("Cannot go back from the current route");
		expo.back();
		return { route: currentRouteName() };
	}
	throw new Error("No navigationRef or router registered");
}

function currentRouteName(): string | undefined {
	return navigationOrNull()?.getCurrentRoute()?.name;
}

function compactState(state: RouteState | undefined): unknown {
	if (!state) return undefined;
	return {
		type: state.type,
		index: state.index,
		routes: state.routes.map((route) => ({
			name: route.name,
			...(route.params !== undefined ? { params: route.params } : {}),
			...(route.state ? { state: compactState(route.state) } : {}),
		})),
	};
}

function focusedPath(state: RouteState | undefined): string[] {
	const path: string[] = [];
	let current = state;
	while (current) {
		const route = current.routes[current.index ?? current.routes.length - 1];
		if (!route) break;
		path.push(route.name);
		current = route.state;
	}
	return path;
}

export function navigationSummary(): unknown {
	const nav = navigationOrNull();
	if (!nav) {
		if (router())
			throw new Error(
				"A router is registered but no navigationRef; pass useNavigationContainerRef() to read route state",
			);
		throw new Error("No navigationRef registered; pass it to useAgentJet()");
	}
	const root = nav.getRootState() as RouteState | undefined;
	return { current: nav.getCurrentRoute(), path: focusedPath(root), state: compactState(root) };
}

export function appName(): string | undefined {
	return shared.options.appName;
}

function queryState() {
	const client = shared.options.queryClient;
	if (!client) return undefined;
	return client
		.getQueryCache()
		.getAll()
		.map((query) => ({
			key: query.queryKey,
			status: query.state.status,
			fetchStatus: query.state.fetchStatus,
			updatedAt: query.state.dataUpdatedAt,
			error: query.state.error instanceof Error ? query.state.error.message : query.state.error,
		}));
}

function getters(): Map<string, () => unknown> {
	const all = new Map<string, () => unknown>();
	for (const [key, value] of Object.entries(shared.options.state ?? {})) {
		all.set(key, typeof value === "function" ? (value as () => unknown) : () => value);
	}
	for (const [key, getter] of shared.registry) all.set(key, getter);
	if (shared.options.queryClient) all.set("queries", queryState);
	return all;
}

function resolve(getter: () => unknown): unknown {
	try {
		return getter();
	} catch (error) {
		return { error: error instanceof Error ? error.message : String(error) };
	}
}

export function readState(key?: string): Record<string, unknown> {
	const all = getters();
	if (key !== undefined) {
		const getter = all.get(key);
		if (!getter) throw new Error(`Unknown state key "${key}"; known keys: ${[...all.keys()].join(", ") || "(none)"}`);
		return { [key]: resolve(getter) };
	}
	const result: Record<string, unknown> = {};
	for (const [name, getter] of all) result[name] = resolve(getter);
	return result;
}
