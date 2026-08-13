import React from 'react';

// Native counterpart of dev-auth-gate.web.tsx. The gate exists to keep a publicly
// reachable dev *deployment* private; a native build isn't served to anyone, so there is
// nothing here to close off — and the web version is built from DOM elements and cookies
// that have no meaning on this platform.
export function DevAuthGate({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
