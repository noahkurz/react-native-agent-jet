import { useState } from "react";
import { Pressable, StyleSheet, Switch, Text, TextInput, View } from "react-native";
import { useAgentJetState } from "react-native-agent-jet";

export default function SettingsScreen() {
	const [name, setName] = useState("");
	const [notifications, setNotifications] = useState(true);
	useAgentJetState("settings", { name, notifications });

	return (
		<View style={styles.container}>
			<Text style={styles.label}>Display name</Text>
			<TextInput
				style={styles.input}
				placeholder="Your name"
				value={name}
				onChangeText={setName}
				accessibilityLabel="display name"
			/>
			<View style={styles.row}>
				<Text style={styles.label}>Notifications</Text>
				<Switch value={notifications} onValueChange={setNotifications} accessibilityLabel="notifications" />
			</View>
			<Pressable style={styles.button} onPress={() => setName("")} accessibilityLabel="reset">
				<Text style={styles.buttonText}>Reset</Text>
			</Pressable>
		</View>
	);
}

const styles = StyleSheet.create({
	container: { flex: 1, padding: 20, gap: 16 },
	label: { fontSize: 16, fontWeight: "600" },
	input: { borderWidth: 1, borderColor: "#ddd", borderRadius: 10, padding: 12, fontSize: 16 },
	row: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
	button: { marginTop: 12, backgroundColor: "#eee", padding: 14, borderRadius: 10, alignItems: "center" },
	buttonText: { fontSize: 16, fontWeight: "600" },
});
