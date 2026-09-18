import { useQuery } from "@tanstack/react-query";
import { router } from "expo-router";
import { useState } from "react";
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, TextInput, View } from "react-native";

type Post = { id: number; title: string };

async function fetchPosts(): Promise<Post[]> {
	const response = await fetch("https://jsonplaceholder.typicode.com/posts?_limit=20");
	if (!response.ok) throw new Error(`Request failed: ${response.status}`);
	return response.json();
}

export default function CatalogScreen() {
	const [search, setSearch] = useState("");
	const { data, isLoading, error } = useQuery({ queryKey: ["posts"], queryFn: fetchPosts });
	const posts = (data ?? []).filter((post) => post.title.includes(search.toLowerCase()));

	return (
		<View style={styles.container}>
			<TextInput
				style={styles.input}
				placeholder="Filter posts"
				value={search}
				onChangeText={setSearch}
				accessibilityLabel="filter"
			/>
			{isLoading ? (
				<ActivityIndicator style={styles.loading} />
			) : error ? (
				<Text style={styles.error}>Failed to load</Text>
			) : (
				<FlatList
					data={posts}
					keyExtractor={(post) => String(post.id)}
					ListEmptyComponent={<Text style={styles.empty}>No matches</Text>}
					renderItem={({ item }) => (
						<Pressable style={styles.item} onPress={() => router.push(`/detail/${item.id}`)}>
							<Text style={styles.itemId}>#{item.id}</Text>
							<Text style={styles.itemTitle} numberOfLines={1}>
								{item.title}
							</Text>
						</Pressable>
					)}
				/>
			)}
		</View>
	);
}

const styles = StyleSheet.create({
	container: { flex: 1, padding: 16, gap: 12 },
	input: { borderWidth: 1, borderColor: "#ddd", borderRadius: 10, padding: 12, fontSize: 16 },
	loading: { marginTop: 40 },
	error: { marginTop: 40, textAlign: "center", color: "#b00" },
	empty: { marginTop: 40, textAlign: "center", color: "#999" },
	item: { flexDirection: "row", gap: 12, paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: "#eee" },
	itemId: { color: "#c07a2b", fontWeight: "700", width: 36 },
	itemTitle: { flex: 1, fontSize: 15 },
});
