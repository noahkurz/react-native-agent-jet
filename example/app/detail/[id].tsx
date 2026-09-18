import { useLocalSearchParams, useRouter } from "expo-router";
import { Pressable, StyleSheet, Text, View } from "react-native";

export default function DetailScreen() {
	const { id } = useLocalSearchParams<{ id: string }>();
	const router = useRouter();

	return (
		<View style={styles.container}>
			<Text style={styles.badge}>Item</Text>
			<Text style={styles.id} accessibilityLabel="item id">
				#{id}
			</Text>
			<Text style={styles.body}>This is the detail screen for item {id}, pushed onto the stack.</Text>
			<Pressable style={styles.button} onPress={() => router.back()} accessibilityLabel="go back">
				<Text style={styles.buttonText}>← Back</Text>
			</Pressable>
		</View>
	);
}

const styles = StyleSheet.create({
	container: { flex: 1, padding: 24, gap: 12, alignItems: "center", justifyContent: "center" },
	badge: { fontSize: 14, color: "#999", textTransform: "uppercase", letterSpacing: 1 },
	id: { fontSize: 56, fontWeight: "800", color: "#c07a2b" },
	body: { fontSize: 16, color: "#555", textAlign: "center" },
	button: { marginTop: 16, backgroundColor: "#c07a2b", paddingHorizontal: 24, paddingVertical: 12, borderRadius: 10 },
	buttonText: { color: "white", fontSize: 16, fontWeight: "600" },
});
