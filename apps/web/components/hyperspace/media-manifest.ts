export type HyperspaceQuality = "high" | "medium" | "low";

export interface HyperspaceMediaSource {
    src: string;
    width: number;
    height: number;
}

export interface HyperspaceMediaItem {
    id: string;
    category: string;
    placement: "hero" | "companion";
    orientation: "portrait" | "landscape";
    aspectRatio: number;
    focalPoint: { x: number; y: number };
    sources: Record<HyperspaceQuality, HyperspaceMediaSource>;
}

const portraitSources = (filename: string): HyperspaceMediaItem["sources"] => ({
    high: { src: `/hyperspace/media/high/${filename}.webp`, width: 1025, height: 1280 },
    medium: { src: `/hyperspace/media/medium/${filename}.webp`, width: 769, height: 960 },
    low: { src: `/hyperspace/media/low/${filename}.webp`, width: 513, height: 640 },
});

const landscapeSources = (filename: string): HyperspaceMediaItem["sources"] => ({
    high: { src: `/hyperspace/media/high/${filename}.webp`, width: 1280, height: 854 },
    medium: { src: `/hyperspace/media/medium/${filename}.webp`, width: 960, height: 640 },
    low: { src: `/hyperspace/media/low/${filename}.webp`, width: 640, height: 427 },
});

const avatarSources = (filename: string): HyperspaceMediaItem["sources"] => ({
    high: { src: `/hyperspace/media/high/${filename}.webp`, width: 1024, height: 1280 },
    medium: { src: `/hyperspace/media/medium/${filename}.webp`, width: 768, height: 960 },
    low: { src: `/hyperspace/media/low/${filename}.webp`, width: 512, height: 640 },
});

const runtimeSources = (
    filename: string,
    dimensions: Record<HyperspaceQuality, readonly [width: number, height: number]>,
): HyperspaceMediaItem["sources"] => ({
    high: {
        src: `/hyperspace/media/high/${filename}.webp`,
        width: dimensions.high[0],
        height: dimensions.high[1],
    },
    medium: {
        src: `/hyperspace/media/medium/${filename}.webp`,
        width: dimensions.medium[0],
        height: dimensions.medium[1],
    },
    low: {
        src: `/hyperspace/media/low/${filename}.webp`,
        width: dimensions.low[0],
        height: dimensions.low[1],
    },
});

const avatarItem = (id: string, category: string): HyperspaceMediaItem => ({
    id,
    category,
    placement: "companion",
    orientation: "portrait",
    aspectRatio: 4 / 5,
    focalPoint: { x: 0.5, y: 0.36 },
    sources: avatarSources(id),
});

export const HYPERSPACE_MEDIA: readonly HyperspaceMediaItem[] = [
    {
        id: "skincare-indian-woman",
        category: "Skincare",
        placement: "hero",
        orientation: "portrait",
        aspectRatio: 1122 / 1402,
        focalPoint: { x: 0.56, y: 0.29 },
        sources: portraitSources("01-skincare-indian-woman"),
    },
    {
        id: "activewear-indian-woman",
        category: "Activewear",
        placement: "hero",
        orientation: "portrait",
        aspectRatio: 1122 / 1402,
        focalPoint: { x: 0.5, y: 0.29 },
        sources: portraitSources("02-activewear-indian-woman"),
    },
    {
        id: "eyewear-east-asian-woman",
        category: "Eyewear",
        placement: "hero",
        orientation: "portrait",
        aspectRatio: 1122 / 1402,
        focalPoint: { x: 0.53, y: 0.37 },
        sources: portraitSources("03-eyewear-east-asian-woman"),
    },
    {
        id: "food-indian-woman",
        category: "Food",
        placement: "hero",
        orientation: "landscape",
        aspectRatio: 1.5,
        focalPoint: { x: 0.52, y: 0.45 },
        sources: landscapeSources("04-food-indian-woman"),
    },
    {
        id: "fashion-women",
        category: "Fashion",
        placement: "hero",
        orientation: "portrait",
        aspectRatio: 1122 / 1402,
        focalPoint: { x: 0.5, y: 0.39 },
        sources: portraitSources("05-fashion-women"),
    },
    {
        id: "lip-color-mediterranean-woman",
        category: "Cosmetics",
        placement: "hero",
        orientation: "portrait",
        aspectRatio: 1122 / 1402,
        focalPoint: { x: 0.61, y: 0.55 },
        sources: portraitSources("06-lip-color-mediterranean-woman"),
    },
    {
        id: "watch-unboxing",
        category: "Watch",
        placement: "hero",
        orientation: "portrait",
        aspectRatio: 1122 / 1402,
        focalPoint: { x: 0.52, y: 0.43 },
        sources: portraitSources("07-watch-unboxing"),
    },
    {
        id: "headphones-black-woman",
        category: "Audio",
        placement: "hero",
        orientation: "portrait",
        aspectRatio: 1122 / 1402,
        focalPoint: { x: 0.53, y: 0.32 },
        sources: portraitSources("08-headphones-black-woman"),
    },
    {
        id: "fragrance-middle-eastern-woman",
        category: "Fragrance",
        placement: "hero",
        orientation: "portrait",
        aspectRatio: 1122 / 1402,
        focalPoint: { x: 0.49, y: 0.35 },
        sources: portraitSources("09-fragrance-middle-eastern-woman"),
    },
    {
        id: "outdoor-jacket-latina-woman",
        category: "Outdoor apparel",
        placement: "hero",
        orientation: "portrait",
        aspectRatio: 1122 / 1402,
        focalPoint: { x: 0.48, y: 0.38 },
        sources: portraitSources("10-outdoor-jacket-latina-woman"),
    },
    {
        id: "tailored-suit-indian-man",
        category: "Tailoring",
        placement: "hero",
        orientation: "landscape",
        aspectRatio: 1.5,
        focalPoint: { x: 0.39, y: 0.42 },
        sources: landscapeSources("11-tailored-suit-indian-man"),
    },
    {
        id: "handbag-filipino-woman",
        category: "Accessory",
        placement: "hero",
        orientation: "portrait",
        aspectRatio: 1122 / 1402,
        focalPoint: { x: 0.44, y: 0.47 },
        sources: portraitSources("12-handbag-filipino-woman"),
    },
    {
        id: "spring-outfit-try-on",
        category: "Fashion creator",
        placement: "hero",
        orientation: "portrait",
        aspectRatio: 405 / 720,
        focalPoint: { x: 0.5, y: 0.42 },
        sources: runtimeSources("13-spring-outfit-try-on", {
            high: [405, 720],
            medium: [405, 720],
            low: [360, 640],
        }),
    },
    {
        id: "lavender-knit-creator",
        category: "Fashion creator",
        placement: "hero",
        orientation: "portrait",
        aspectRatio: 506 / 900,
        focalPoint: { x: 0.5, y: 0.4 },
        sources: runtimeSources("14-lavender-knit", {
            high: [506, 900],
            medium: [506, 900],
            low: [360, 640],
        }),
    },
    {
        id: "mora-daily-gummies",
        category: "Wellness product",
        placement: "hero",
        orientation: "portrait",
        aspectRatio: 4 / 5,
        focalPoint: { x: 0.5, y: 0.5 },
        sources: runtimeSources("15-mora-daily-gummies", {
            high: [880, 1100],
            medium: [768, 960],
            low: [512, 640],
        }),
    },
    {
        id: "mora-store-creator",
        category: "Wellness creator",
        placement: "hero",
        orientation: "portrait",
        aspectRatio: 788 / 1400,
        focalPoint: { x: 0.5, y: 0.42 },
        sources: runtimeSources("16-mora-store-creator", {
            high: [721, 1280],
            medium: [541, 960],
            low: [361, 640],
        }),
    },
    {
        id: "mykso-creator",
        category: "Creator campaign",
        placement: "hero",
        orientation: "portrait",
        aspectRatio: 788 / 1400,
        focalPoint: { x: 0.5, y: 0.42 },
        sources: runtimeSources("17-mykso-creator", {
            high: [721, 1280],
            medium: [541, 960],
            low: [361, 640],
        }),
    },
    {
        id: "concert-day-diary",
        category: "Event creator",
        placement: "hero",
        orientation: "portrait",
        aspectRatio: 405 / 720,
        focalPoint: { x: 0.5, y: 0.45 },
        sources: runtimeSources("18-concert-day-diary", {
            high: [405, 720],
            medium: [405, 720],
            low: [360, 640],
        }),
    },
    {
        id: "frozen-lake-duel",
        category: "Entertainment campaign",
        placement: "hero",
        orientation: "portrait",
        aspectRatio: 405 / 720,
        focalPoint: { x: 0.5, y: 0.45 },
        sources: runtimeSources("20-frozen-lake-duel", {
            high: [405, 720],
            medium: [405, 720],
            low: [360, 640],
        }),
    },
    {
        id: "sky-ram-warrior",
        category: "Entertainment campaign",
        placement: "hero",
        orientation: "portrait",
        aspectRatio: 405 / 720,
        focalPoint: { x: 0.5, y: 0.45 },
        sources: runtimeSources("21-sky-ram-warrior", {
            high: [405, 720],
            medium: [405, 720],
            low: [360, 640],
        }),
    },
    {
        id: "desk-pitch",
        category: "Creative pitch",
        placement: "hero",
        orientation: "portrait",
        aspectRatio: 506 / 900,
        focalPoint: { x: 0.5, y: 0.46 },
        sources: runtimeSources("22-desk-pitch", {
            high: [506, 900],
            medium: [506, 900],
            low: [360, 640],
        }),
    },
    {
        id: "supermarket-date",
        category: "Lifestyle campaign",
        placement: "hero",
        orientation: "portrait",
        aspectRatio: 506 / 900,
        focalPoint: { x: 0.5, y: 0.46 },
        sources: runtimeSources("23-supermarket-date", {
            high: [506, 900],
            medium: [506, 900],
            low: [360, 640],
        }),
    },
    avatarItem("avatar-001", "Lifestyle"),
    avatarItem("avatar-006", "Fitness"),
    avatarItem("avatar-016", "Career"),
    avatarItem("avatar-018", "Creative studio"),
    avatarItem("avatar-027", "Fitness"),
    avatarItem("avatar-034", "Motion design"),
    avatarItem("avatar-037", "Everyday creator"),
    avatarItem("avatar-039", "Beauty creator"),
] as const;
