import { Tabs } from "expo-router";
import { Text, type ColorValue } from "react-native";

function Icon({ label, color }: { label: string; color: ColorValue }) {
	return <Text style={{ color, fontSize: 18 }}>{label}</Text>;
}

export default function TabLayout() {
	return (
		<Tabs screenOptions={{ tabBarActiveTintColor: "#c07a2b" }}>
			<Tabs.Screen
				name="index"
				options={{ title: "Home", tabBarIcon: ({ color }: { color: ColorValue }) => <Icon label="⌂" color={color} /> }}
			/>
			<Tabs.Screen
				name="catalog"
				options={{
					title: "Catalog",
					tabBarIcon: ({ color }: { color: ColorValue }) => <Icon label="☰" color={color} />,
				}}
			/>
			<Tabs.Screen
				name="settings"
				options={{
					title: "Settings",
					tabBarIcon: ({ color }: { color: ColorValue }) => <Icon label="⚙" color={color} />,
				}}
			/>
		</Tabs>
	);
}
