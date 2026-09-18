import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { router, Stack, useNavigationContainerRef } from "expo-router";
import { useAgentJet, type ExpoRouterLike } from "react-native-agent-jet";

const queryClient = new QueryClient();

export default function RootLayout() {
	const navigationRef = useNavigationContainerRef();
	useAgentJet({ navigationRef, router: router as ExpoRouterLike, queryClient, appName: "agent-jet-demo" });

	return (
		<QueryClientProvider client={queryClient}>
			<Stack>
				<Stack.Screen name="(tabs)" options={{ headerShown: false }} />
				<Stack.Screen name="detail/[id]" options={{ title: "Detail" }} />
			</Stack>
		</QueryClientProvider>
	);
}
