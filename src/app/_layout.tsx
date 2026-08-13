import "../global.css";

import { DarkTheme, DefaultTheme, ThemeProvider } from 'expo-router';
import { useColorScheme } from 'react-native';

import { AnimatedSplashOverlay } from '@/components/animated-icon';
import AppTabs from '@/components/app-tabs';
import { DevAuthGate } from '@/components/dev-auth-gate';

export default function TabLayout() {
  const colorScheme = useColorScheme();
  return (
    <ThemeProvider value={colorScheme === 'dark' ? DarkTheme : DefaultTheme}>
      {/* Wraps everything, splash included: in a dev build nothing mounts until the
          EXPO_ADMIN sign-in succeeds. Transparent in a production build. */}
      <DevAuthGate>
        <AnimatedSplashOverlay />
        <AppTabs />
      </DevAuthGate>
    </ThemeProvider>
  );
}
