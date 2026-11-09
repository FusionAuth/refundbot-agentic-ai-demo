/** The fictional store's logo mark: a sun-on-horizon in the brand teal. */
export default function BrightlineMark({ size = 32, inverted = false }: { size?: number; inverted?: boolean }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <rect width="32" height="32" rx="8" fill={inverted ? "#ffffff" : "var(--color-brand)"} />
      <circle cx="16" cy="18" r="6" fill={inverted ? "var(--color-brand)" : "#ffffff"} />
      <rect x="6" y="18" width="20" height="8" fill={inverted ? "#ffffff" : "var(--color-brand)"} />
      <rect x="6" y="19.5" width="20" height="1.6" rx="0.8" fill={inverted ? "var(--color-brand)" : "#ffffff"} />
    </svg>
  );
}
