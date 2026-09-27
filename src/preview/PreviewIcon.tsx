import type React from 'react';

export function PreviewIcon({ name }: { name: string }) {
  const paths: Record<string, React.ReactNode> = {
    rect: <rect x="4" y="4" width="16" height="16" rx="2" strokeDasharray="3 3" />,
    arrow: <path d="M5 19 19 5M8 5h11v11" />,
    text: <path d="M4 5h16M12 5v15M8 20h8" />,
    comment: <path d="M4 4h16v13H9l-5 4V4m4 5h8m-8 4h5" />,
    edit: (
      <>
        <path d="m15 4 5 5M4 20l5-1L20 8a3.5 3.5 0 0 0-5-5L4 14z" />
      </>
    ),
    desktop: (
      <>
        <rect x="3" y="4" width="18" height="13" rx="2" />
        <path d="M8 21h8m-4-4v4" />
      </>
    ),
    tablet: (
      <>
        <rect x="4" y="3" width="16" height="18" rx="2" />
        <path d="M12 17h.01" />
      </>
    ),
    phone: (
      <>
        <rect x="7" y="2" width="10" height="20" rx="2" />
        <path d="M12 18h.01" />
      </>
    ),
    code: (
      <>
        <path d="m8 6-6 6 6 6m8-12 6 6-6 6M14 3l-4 18" />
      </>
    ),
    eye: (
      <>
        <path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12Z" />
        <circle cx="12" cy="12" r="3" />
      </>
    ),
    refresh: (
      <>
        <path d="M20 7v5h-5M4 17v-5h5" />
        <path d="M6 7a7 7 0 0 1 12-1l2 3M4 15l2 3a7 7 0 0 0 12-1" />
      </>
    ),
    external: (
      <>
        <path d="M14 3h7v7m0-7L10 14M10 3H4a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h16a1 1 0 0 0 1-1v-6" />
      </>
    ),
    fit: (
      <>
        <rect x="6" y="7" width="12" height="10" rx="1" />
        <path d="M7 3H3v4m14-4h4v4M3 17v4h4m10 0h4v-4" />
      </>
    ),
    close: <path d="m6 6 12 12M18 6 6 18" />,
    expand: <path d="M9 3H3v6m12-6h6v6M3 15v6h6m6 0h6v-6" />,
    dock: (
      <>
        <rect x="3" y="4" width="18" height="16" rx="2" />
        <path d="M14 4v16" />
      </>
    ),
    plus: <path d="M5 12h14M12 5v14" />,
    minus: <path d="M5 12h14" />,
    left: <path d="m14 6-6 6 6 6" />,
    right: <path d="m10 6 6 6-6 6" />,
    save: (
      <>
        <path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5" />
      </>
    ),
    image: (
      <>
        <rect x="3" y="3" width="18" height="18" rx="3" />
        <circle cx="8" cy="8" r="1" />
        <path d="m3 17 6-6 4 4 3-3 5 5" />
      </>
    ),
    pages: (
      <>
        <rect x="3" y="4" width="5" height="16" rx="1" />
        <rect x="12" y="4" width="9" height="16" rx="1" />
      </>
    ),
  };
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name] || paths.image}
    </svg>
  );
}
