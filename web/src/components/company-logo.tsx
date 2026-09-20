import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { logoUrl, monogram, monogramHue } from "@/lib/logo";

/**
 * The company's mark, beside its name at the top of the dashboard. The logo
 * host is a third party that knows nothing of the rest of the page (see
 * lib/logo.ts), so a company it has never heard of, a blocked request and an
 * unconfigured host all land in the same place: the ticker's own monogram,
 * which needs no network at all. The heading already names the company, so
 * the mark itself is decorative.
 */
export function CompanyLogo({
  ticker,
  name,
}: {
  ticker: string;
  name: string;
}) {
  const source = useMemo(() => logoUrl(ticker), [ticker]);
  const [failed, setFailed] = useState(false);
  // Opening another company must retry that company's logo, not inherit the
  // previous one's failure.
  useEffect(() => setFailed(false), [source]);
  return (
    <span
      className="company-logo"
      style={{ "--monogram-hue": monogramHue(ticker) } as CSSProperties}
      aria-hidden="true"
    >
      {source && !failed ? (
        <img
          src={source}
          alt=""
          decoding="async"
          referrerPolicy="no-referrer"
          onError={() => setFailed(true)}
        />
      ) : (
        <span className="company-monogram">{monogram(ticker, name)}</span>
      )}
    </span>
  );
}
