import { OverlayView } from './overlay-view';

/**
 * The OBS overlay (FR-2.3).
 *
 * `noindex` because the URL *is* the credential: a search engine that indexed it would
 * publish a live overlay. The API sends the same header, so both halves agree.
 */
export const metadata = {
  title: 'Overlay',
  robots: { index: false, follow: false, nocache: true },
};

export default async function OverlayPage({
  params,
}: {
  params: Promise<{ token: string }>;
}): Promise<React.JSX.Element> {
  const { token } = await params;
  // The token is handed to the client component and used only to open the SSE stream.
  // It is never rendered into the page, so it cannot end up in a screenshot of the source.
  return <OverlayView token={token} />;
}
