import "../global.css";

import { DarkTheme, DefaultTheme, ThemeProvider } from 'expo-router';
import { useColorScheme } from 'react-native';

import { AnimatedSplashOverlay } from '@/components/animated-icon';
import AppTabs from '@/components/app-tabs';
import { DevAuthGate } from '@/components/dev-auth-gate';
import { I18nProvider } from '@/i18n/provider';

export default function TabLayout() {
  const colorScheme = useColorScheme();
  return (
    <ThemeProvider value={colorScheme === 'dark' ? DarkTheme : DefaultTheme}>
      {/* Outermost, so the language is settled before any copy renders — including the
          sign-in gate's. Resolves ?lang= against EXPO_PUBLIC_DEFAULT_LANGUAGE; see
          i18n/index.ts. */}
      <I18nProvider>
        {/* Wraps everything, splash included: in a dev build nothing mounts until the
            EXPO_ADMIN sign-in succeeds. Transparent in a production build. */}
        <DevAuthGate>
          <AnimatedSplashOverlay />
          <AppTabs />
        </DevAuthGate>
      </I18nProvider>
    </ThemeProvider>
  );
}
