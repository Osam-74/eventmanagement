/**
 * The public guest-upload link for an event, and its QR.
 *
 * The base is the site's canonical domain, NOT whatever URL the admin happens
 * to have open: the old *.vercel.app domain now 308-redirects to the custom
 * domain, and a link/QR built from it would print the wrong address on
 * posters. Override with NEXT_PUBLIC_SITE_URL if the domain ever changes.
 */
export const DEFAULT_SITE_URL = 'https://eventmgt.deodevs.com';

export function siteBaseUrl(): string {
  const raw = (process.env.NEXT_PUBLIC_SITE_URL || DEFAULT_SITE_URL).trim();
  return raw.replace(/\/+$/, '');
}

export function guestMomentsUrl(slug: string): string {
  return `${siteBaseUrl()}/moments/${encodeURIComponent(slug)}`;
}
