import { useEffect, useState, type FormEvent } from "react";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Card } from "./ui/card";
import { Alert, AlertDescription } from "./ui/alert";
import {
  clearStocks,
  protectStorage,
  savedStocks,
  storeKey,
  type SavedStock,
} from "@/lib/storage";

export function DataSettings({
  apiKey,
  onKey,
  onClose,
  onOpenStock,
  busy,
}: {
  apiKey: string;
  onKey: (key: string) => void;
  onClose: () => void;
  onOpenStock: (ticker: string) => void;
  busy: boolean;
}) {
  const [key, setKey] = useState(apiKey);
  const [remember, setRemember] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [stocks, setStocks] = useState<SavedStock[]>([]);
  const [clearing, setClearing] = useState(false);
  useEffect(() => {
    savedStocks()
      .then(setStocks)
      .catch((e) => setError(e.message));
  }, []);
  async function save(e: FormEvent) {
    e.preventDefault();
    setError("");
    const value = key.trim();
    if (!/^[A-Za-z0-9]{1,128}$/.test(value)) {
      setError(
        "Enter the API key provided by Alpha Vantage (letters and numbers only).",
      );
      return;
    }
    try {
      storeKey(value, remember);
      onKey(value);
      // Called from an explicit user action; the browser decides whether to grant protection.
      const persistent = await protectStorage();
      setMessage(
        `Key saved${remember ? " on this device" : " for this tab"}. It will be checked with your first stock request. ${persistent ? "Persistent storage is enabled." : "Statements are stored locally; your browser may remove them if storage is low."}`,
      );
    } catch {
      setError(
        "Your browser could not save the key. Allow site storage and try again.",
      );
    }
  }
  async function clear() {
    setError("");
    try {
      await clearStocks();
      setStocks([]);
      setClearing(false);
      setMessage("Saved statements and prices cleared. Your API key was kept.");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }
  return (
    <section className="settings-panel" aria-labelledby="settings-title">
      <Card className="settings-card">
        <div className="flex items-center justify-between gap-4">
          <div>
            <p className="eyebrow">YOUR DATA CONNECTION</p>
            <h2 id="settings-title">Optional Alpha Vantage fallback</h2>
          </div>
          <Button variant="ghost" onClick={onClose}>
            Close settings
          </Button>
        </div>
        <p className="footnote">
          Yahoo Finance is tried first, then SEC EDGAR. You can search without a
          key. Add an Alpha Vantage key only to fill remaining gaps. Your key is
          sent to this app's provider service, which forwards it only to Alpha
          Vantage for fallback requests.
          <a
            href="https://www.alphavantage.co/support/#api-key"
            target="_blank"
            rel="noreferrer"
          >
            {" "}
            Get an Alpha Vantage key ↗
          </a>
        </p>
        <form onSubmit={save} className="key-form">
          <label htmlFor="alpha-key">Alpha Vantage API key</label>
          <Input
            id="alpha-key"
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={key}
            onChange={(e) => setKey(e.target.value)}
            placeholder="Paste your API key"
            required
            maxLength={128}
          />
          <label className="remember-key">
            <input
              type="checkbox"
              checked={remember}
              onChange={(e) => setRemember(e.target.checked)}
            />{" "}
            Remember my key on this device
          </label>
          <p className="footnote">
            By default, your key stays in this tab’s session. Remembered keys
            are stored in this browser’s site storage; use this only on a
            trusted device.
          </p>
          <div className="flex gap-3 flex-wrap">
            <Button type="submit" disabled={busy}>
              Save API key
            </Button>
            {apiKey && (
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                onClick={() => {
                  try {
                    storeKey("", false);
                    onKey("");
                    setKey("");
                    setMessage(
                      "API key removed. Saved statements are still available.",
                    );
                  } catch {
                    setError(
                      "Could not remove the saved key. Clear this site’s storage in browser settings.",
                    );
                  }
                }}
              >
                Forget API key
              </Button>
            )}
          </div>
        </form>
        {message && (
          <Alert role="status" className="settings-message">
            <AlertDescription>{message}</AlertDescription>
          </Alert>
        )}
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        <div className="saved-stocks">
          <h3>Saved on this device</h3>
          <p className="footnote">
            Statements and prices are saved in this browser profile, separately
            for each site address. They have no automatic expiry. Use Refresh
            data to update statements and Refresh price to update the chart.
            Clearing site data or using private browsing can remove saved data.
          </p>
          {stocks.length ? (
            <ul>
              {stocks
                .sort((a, b) => a.ticker.localeCompare(b.ticker))
                .map((stock) => (
                  <li key={stock.ticker}>
                    <Button
                      variant="outline"
                      disabled={busy}
                      onClick={() => onOpenStock(stock.ticker)}
                    >
                      {stock.ticker}
                    </Button>
                    <span>
                      Saved {new Date(stock.fetchedAt).toLocaleDateString()}
                    </span>
                  </li>
                ))}
            </ul>
          ) : (
            <p className="footnote">No stocks saved yet.</p>
          )}
          {clearing ? (
            <div className="flex flex-wrap items-center gap-3">
              <span>
                Remove all saved statements and prices from this browser?
              </span>
              <Button variant="destructive" disabled={busy} onClick={clear}>
                Remove saved statements
              </Button>
              <Button variant="ghost" onClick={() => setClearing(false)}>
                Cancel
              </Button>
            </div>
          ) : (
            <Button
              variant="outline"
              disabled={busy || !stocks.length}
              onClick={() => setClearing(true)}
            >
              Clear saved statements
            </Button>
          )}
          <p className="footnote mt-3">
            Export CSV from a report to keep a regular file. Saved reports make
            no provider requests.
          </p>
        </div>
      </Card>
    </section>
  );
}
