// The editor, optionally opened against a review asset: http://localhost/?uuid=<uuid>.
//
// The query form is an alternate spelling of the /<uuid> deep link in [uuid].tsx, for
// callers that can append to a URL but not shape its path — an embed src that already
// carries ?lang=, or anything assembling the address from a fixed base. Both resolve the
// same way through asReviewUuid and hand the same prop to the same component, so there is
// one load path rather than two that can drift.
//
// A missing or malformed ?uuid= renders the plain editor, exactly as / always has.
import { useLocalSearchParams } from 'expo-router';

import { SvgDropZone } from '@/components/svg-drop-zone';
import { asReviewUuid } from '@/lib/review-uuid';

export default function HomeScreen() {
  const { uuid } = useLocalSearchParams<{ uuid?: string }>();

  return <SvgDropZone reviewUuid={asReviewUuid(uuid)} />;
}
