import { Slot } from 'expo-router';

// One screen, no tab bar: the app is the editor (and on native, a note to open it in a
// browser), so the layout just renders whichever route matched.
export default function AppTabs() {
  return <Slot />;
}
