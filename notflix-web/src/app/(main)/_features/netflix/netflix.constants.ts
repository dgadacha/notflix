export const HERO = {
    rotateMs: 12_000,
    poolSize: 8,
    /** Heights tuned per viewport. Mobile gets a shorter hero so the rows
     *  below are reachable without scrolling past a giant banner.          */
    heightClass: "h-[70vh] min-h-[420px] lg:h-[85vh] lg:min-h-[560px]",
} as const

export const ROW = {
    /** Cards: 220 on mobile (fits ~1.5 of them on a 375px viewport so the
     *  partial card hints at horizontal scroll), 340 on desktop.           */
    cardWidthClass: "w-[220px] sm:w-[260px] lg:w-[340px]",
    /** Vertical breathing room so the hover-scale doesn't bleed into the row above/below. */
    scrollPaddingY: "py-4 lg:py-6",
    /** Horizontal padding — kept identical on the title and the scroller so they stay flush. */
    paddingX: "px-4 sm:px-6 lg:px-16",
    skeletonCount: 8,
} as const

export const FORMAT_LABEL: Record<string, string> = {
    TV: "Série",
    TV_SHORT: "Court",
    MOVIE: "Film",
    SPECIAL: "Spécial",
    OVA: "OVA",
    ONA: "ONA",
    MUSIC: "Musique",
}
