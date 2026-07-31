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
import { useLocalSearchParams } from 'expo-router';

import { SvgDropZone } from '@/components/svg-drop-zone';

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export default function ReviewScreen() {
  const { uuid } = useLocalSearchParams<{ uuid: string }>();
  const reviewUuid = uuid && UUID_RE.test(uuid) ? uuid : undefined;

  return <SvgDropZone reviewUuid={reviewUuid} />;
}
