/** Fiber tags and component names we match on, named so the matching reads as intent. */

/** react-reconciler work tags for host (native) nodes. */
export const HOST_COMPONENT = 5;
export const HOST_TEXT = 6;

/** React Native host component names. */
export const RN_TEXT = "RCTText";
export const RN_SCROLL_VIEW = "RCTScrollView";
/** react-native-screens stack: only its last child is the screen actually on top. */
export const RN_SCREEN_STACK = "RNSScreenStack";

/** Names we report to the agent, chosen to match what a developer would call them. */
export const TEXT_TYPE = "Text";
export const TEXT_INPUT_TYPE = "TextInput";
export const SCROLL_VIEW_TYPE = "ScrollView";
export const ROOT_TYPE = "Root";
