import { View, Text } from 'react-native';

// reviewUuid is web-only (the /<uuid> deep link); accepted here so the two platform
// signatures match, and ignored — there's no editor on native.
export function SvgDropZone(_props: { reviewUuid?: string } = {}) {
  return (
    <View className="flex-1 items-center justify-center bg-zinc-950">
      <Text className="text-zinc-400 text-sm">SVG editor — open in browser to use</Text>
    </View>
  );
}
