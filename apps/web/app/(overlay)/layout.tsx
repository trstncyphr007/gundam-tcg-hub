import type { Metadata } from 'next';
import type { ReactNode } from 'react';

/**
 * A second root layout, for the OBS overlay only.
 *
 * The site layout wraps everything in a header, nav and a centred column. An overlay must
 * be none of those: OBS composites the page straight over the video, so any background,
 * margin or chrome would appear on stream as a grey box. Route groups let the two roots
 * coexist without changing a single URL.
 */
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Overlay',
  // The URL is the credential; an indexed overlay is a published one.
  robots: { index: false, follow: false, nocache: true },
};

export default function OverlayLayout({ children }: { children: ReactNode }): React.JSX.Element {
  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          padding: 0,
          // Transparent, not a colour: OBS keys on the absence of a background.
          background: 'transparent',
          overflow: 'hidden',
        }}
      >
        {children}
      </body>
    </html>
  );
}
