const paths = {
  home: 'm3 10 9-7 9 7v10a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1z',
  library: 'm12 3 9 5-9 5-9-5zM3 12l9 5 9-5M3 16l9 5 9-5',
  projects: 'M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z',
  tasks: 'M6 3h12a3 3 0 0 1 3 3v12a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3V6a3 3 0 0 1 3-3zm2 9 3 3 5-6',
  trash: 'M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 10v7m4-7v7',
  search: 'M16.2 16.2 21 21M18.5 10.5a8 8 0 1 1-16 0 8 8 0 0 1 16 0Z',
  clip: 'm8 13 6-6a3 3 0 0 1 4 4l-8 8a5 5 0 0 1-7-7l9-9',
  arrow: 'M4 12h15m-6-6 6 6-6 6',
  chevron: 'm9 6 6 6-6 6',
  note: 'M6 3h8l4 4v14H6zM14 3v5h4M9 12h6m-6 4h6',
  idea: 'M9 18h6m-5 3h4m-5-6a6 6 0 1 1 6 0',
  link: 'm10 13 4-4m-6 6-2 2a3 3 0 0 1-4-4l5-5a3 3 0 0 1 4 0m2 6a3 3 0 0 0 4 0l5-5a3 3 0 0 0-4-4l-2 2',
  close: 'm6 6 12 12M18 6 6 18',
};

export function Icon({ name }: { name: keyof typeof paths }) {
  return <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true" fill="none"
    stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
    <path d={paths[name]} />
  </svg>;
}
