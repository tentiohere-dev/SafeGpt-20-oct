import {
  Inter_400Regular,
  Inter_500Medium,
  Inter_600SemiBold,
  Inter_700Bold,
  useFonts,
} from "@expo-google-fonts/inter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Stack } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import React, { useEffect, useState } from "react";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { KeyboardProvider } from "react-native-keyboard-controller";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { useColorScheme } from "react-native";

import { ErrorBoundary } from "@/components/ErrorBoundary";
import { AppProvider, useApp } from "@/context/AppContext";
import { SplashLoadingScreen } from "@/components/SplashLoadingScreen";
import { LoginScreen } from "@/components/LoginScreen";
import { OnboardingScreen } from "@/components/OnboardingScreen";
import { requestAppPermissions } from "@/services/authService";

SplashScreen.preventAutoHideAsync();

const queryClient = new QueryClient();

function AppGate() {
  const { isAuthenticated, isFirstLaunch } = useApp();
  const [showingSplash, setShowingSplash] = useState(true);

  if (showingSplash) {
    return <SplashLoadingScreen onDone={() => setShowingSplash(false)} />;
  }

  if (!isAuthenticated) {
    return <LoginScreen />;
  }

  if (isFirstLaunch) {
    return <OnboardingScreen />;
  }

  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
    </Stack>
  );
}

export default function RootLayout() {
  const [fontsLoaded, fontError] = useFonts({
    Inter_400Regular,
    Inter_500Medium,
    Inter_600SemiBold,
    Inter_700Bold,
  });

  useEffect(() => {
    if (fontsLoaded || fontError) {
      SplashScreen.hideAsync();
      requestAppPermissions(); // request camera, microphone, photo library
    }
  }, [fontsLoaded, fontError]);

  if (!fontsLoaded && !fontError) return null;

  return (
    <SafeAreaProvider>
      <ErrorBoundary>
        <QueryClientProvider client={queryClient}>
          <GestureHandlerRootView style={{ flex: 1 }}>
            <KeyboardProvider>
              <AppProvider>
                <AppGate />
              </AppProvider>
            </KeyboardProvider>
          </GestureHandlerRootView>
        </QueryClientProvider>
      </ErrorBoundary>
    </SafeAreaProvider>
  );
}
