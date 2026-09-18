import { router } from "expo-router";
import { useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useAgentJetState } from "react-native-agent-jet";

export default function HomeScreen() {
	const [count, setCount] = useState(0);
	useAgentJetState("counter", count);

	return (
		<ScrollView contentContainerStyle={styles.container}>
			<Text style={styles.title}>Agent Jet Demo</Text>
			<Text style={styles.subtitle}>A tiny Expo Router app for driving with react-native-agent-jet.</Text>

			<View style={styles.card}>
				<Text style={styles.cardTitle}>Counter</Text>
				<Text style={styles.count} accessibilityLabel="counter value">
					{count}
				</Text>
				<View style={styles.row}>
					<Pressable style={styles.button} onPress={() => setCount((c) => c - 1)} accessibilityLabel="decrement">
						<Text style={styles.buttonText}>−</Text>
					</Pressable>
					<Pressable style={styles.button} onPress={() => setCount((c) => c + 1)} accessibilityLabel="increment">
						<Text style={styles.buttonText}>+</Text>
					</Pressable>
				</View>
			</View>

			<Pressable style={styles.linkButton} onPress={() => router.push("/detail/42")}>
				<Text style={styles.linkText}>Open item #42 →</Text>
			</Pressable>
		</ScrollView>
	);
}

const styles = StyleSheet.create({
	container: { padding: 20, gap: 16 },
	title: { fontSize: 28, fontWeight: "700" },
	subtitle: { fontSize: 15, color: "#666" },
	card: { backgroundColor: "#f5f0e8", borderRadius: 12, padding: 20, gap: 12, alignItems: "center" },
	cardTitle: { fontSize: 16, fontWeight: "600" },
	count: { fontSize: 48, fontWeight: "800", color: "#c07a2b" },
	row: { flexDirection: "row", gap: 16 },
	button: {
		backgroundColor: "#c07a2b",
		width: 56,
		height: 56,
		borderRadius: 28,
		alignItems: "center",
		justifyContent: "center",
	},
	buttonText: { color: "white", fontSize: 28, fontWeight: "700" },
	linkButton: { padding: 16, borderRadius: 12, borderWidth: 1, borderColor: "#c07a2b", alignItems: "center" },
	linkText: { color: "#c07a2b", fontSize: 16, fontWeight: "600" },
});
