/** Placeholder madeleine logo until a designer draws the real one (docs/design-identity.md#logo). */
export function Madeleine({ size = 32, className }: { size?: number; className?: string }) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 64 64"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M32 6C17 6 6 18 6 32c0 9 5 17 13 22h26c8-5 13-13 13-22C58 18 47 6 32 6z" fill="#C98A3D" />
      <path
        d="M32 54V12M32 54 16 16M32 54 48 16M32 54 9 26M32 54 55 26"
        stroke="#8F5E24"
        strokeWidth="2.5"
        strokeLinecap="round"
        fill="none"
      />
    </svg>
  );
}

/** Placeholder for the town illustration: a soft skyline with the church steeple. */
export function Skyline() {
  return (
    <svg className="skyline" viewBox="0 0 960 48" preserveAspectRatio="none" aria-hidden="true">
      <path
        fill="currentColor"
        d="M0 48V34h40v-8l14-8 14 8v8h50V28h22v-6h18v12h60l10-10 10 10h40V20l8-20 8 20v14h30v-8h26v8h70l16-12 16 12h60v-6h30v6h80l12-8 12 8h50v-10h20v10h90l14-10 14 10H960V48z"
      />
    </svg>
  );
}
