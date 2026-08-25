// The editor opened against a review asset: http://localhost/<uuid>.
//
// Renders the same editor as `/`, handing the uuid down so the drop zone can resolve
// it: POST /api/review/check/<uuid> for the numeric id and edit flag, then the
// /api/review/<id> download, then the SVG onto the canvas. That whole flow lives in
// SvgDropZone (it owns the loading state and the open path); this route only decides
// whether the path segment is a uuid worth resolving.
//
// Static routes win over this one in expo-router, so /explore and friends are
// unaffected; a non-uuid segment just renders the editor with nothing to load.
//
// /?uuid=<uuid> on the index route is the same thing said another way — see index.tsx.
// Both spell the check with asReviewUuid so neither can accept a value the other refuses.
import { useLocalSearchParams } from 'expo-router';

import { SvgDropZone } from '@/components/svg-drop-zone';
import { asReviewUuid } from '@/lib/review-uuid';

export default function ReviewScreen() {
  // Path segment and query string land in the same bag here, so a /<uuid> link keeps
  // working and a stray ?uuid= on this route resolves rather than being quietly dropped.
  const { uuid } = useLocalSearchParams<{ uuid?: string }>();

  return <SvgDropZone reviewUuid={asReviewUuid(uuid)} />;
}
