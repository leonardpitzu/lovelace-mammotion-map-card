declare const __VERSION__: string;
declare const __BUILD_ID__: string;

// Metres per degree.  Good to well under a millimetre over a garden-sized
// extent, which is the only scale this card ever renders.
const M_PER_DEG_LAT = 110574;
const M_PER_DEG_LON = 111320;

// Static geometry is re-fetched every Nth progress tick; zones change rarely.
const STATIC_EVERY = 10;
const MIN_INTERVAL_S = 30;

// Lawn-mower states that belong to a running job.  A job starts on the first
// "mowing" that follows any other state; the trail is reset there.
const ACTIVE_STATES = ["mowing", "paused", "returning"];

// Tracker fixes further apart than this are not joined: outside the 5-minute
// report stream the tracker updates every few minutes, and a straight line
// across the lawn between two such fixes would be fiction.
const TRAIL_GAP_S = 45;
const TRAIL_LOOKBACK_H = 24;

// The integration blips mowing -> docked -> mowing within milliseconds; only
// a stop longer than this ends a job.
const JOB_GAP_S = 60;

const ROUTE_TYPES = ["mow_path", "border_pass"];

type Position = [number, number];

interface Fix {
    t: number;
    lon: number;
    lat: number;
}

// The recorder's compressed history rows: state, attributes, last_updated (epoch s).
interface HistoryRow {
    s: string;
    a?: Record<string, unknown>;
    lu: number;
}

type Geometry =
    | { type: "Point"; coordinates: Position }
    | { type: "MultiPoint"; coordinates: Position[] }
    | { type: "LineString"; coordinates: Position[] }
    | { type: "MultiLineString"; coordinates: Position[][] }
    | { type: "Polygon"; coordinates: Position[][] }
    | { type: "MultiPolygon"; coordinates: Position[][][] };

interface FeatureProperties {
    type_name?: string;
    Name?: string;
    title?: string;
    name?: string;
    area?: number;
    color?: string;
    fillColor?: string;
    weight?: number;
    opacity?: number;
    fillOpacity?: number;
    dashArray?: string;
    lineCap?: string;
    lineJoin?: string;
}

interface Feature {
    geometry?: Geometry;
    properties?: FeatureProperties;
}

interface FeatureCollection {
    type?: string;
    features: Feature[];
}

interface HassEntity {
    state: string;
    attributes: Record<string, unknown>;
    last_updated: string;
}

interface Hass {
    states: Record<string, HassEntity | undefined>;
    callWS<T>(message: Record<string, unknown>): Promise<T>;
}

interface CardConfig {
    entity: string;
    tracker: string | null;
    title: string | null;
    hide_types: string[];
    hide_names: string[];
    show_labels: boolean;
    show_progress: boolean;
    show_route: boolean;
    show_trail: boolean;
    trail_width: number;
    progress_interval: number;
    padding: number;
}

interface MowerFix {
    lat: number;
    lon: number;
    heading: number;
    accuracy: number;
    state: string;
}

const DEFAULTS: Omit<CardConfig, "entity"> = {
    tracker: null,
    title: null,
    hide_types: [],
    hide_names: [],
    show_labels: true,
    show_progress: true,
    show_route: true,
    show_trail: true,
    trail_width: 0.22,
    progress_interval: 180,
    padding: 18
};

const STACKED = ["area", "path", "obstacle", "station"];

const esc = (value: string | number | null | undefined): string => String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const num = (value: unknown, fallback: number): number => {
    const parsed = Number(value);

    return Number.isFinite(parsed) ? parsed : fallback;
};

const featureName = (props: FeatureProperties): string => props.Name ?? props.title ?? props.name ?? "";

/** Walks every [lon, lat] pair of a geometry regardless of nesting depth. */
function eachPosition(geometry: Geometry | undefined, visit: (position: Position) => void): void {
    if (!geometry) {
        return;
    }

    const depths: Record<Geometry["type"], number> = {
        Point: 0,
        MultiPoint: 1,
        LineString: 1,
        MultiLineString: 2,
        Polygon: 2,
        MultiPolygon: 3
    };

    const depth = depths[geometry.type];

    const walk = (node: unknown, remaining: number): void => {
        if (remaining === 0) {
            visit(node as Position);
        } else if (Array.isArray(node)) {
            for (const child of node) {
                walk(child, remaining - 1);
            }
        }
    };

    walk(geometry.coordinates, depth);
}

class MammotionMapCard extends HTMLElement {
    private config!: CardConfig;
    private hassObj: Hass | null = null;
    private card!: HTMLElement;
    private canvas!: HTMLElement;
    private svg!: SVGSVGElement;
    private message!: HTMLElement;

    private staticData: FeatureCollection | null = null;
    private progressData: FeatureCollection | null = null;
    private routeData: FeatureCollection | null = null;

    // The mown trail: tracker fixes since the job started, plus every
    // dynamics-line window seen, keyed by its first point.  The integration
    // only ever hands out the last few metres of the dynamics line.
    private fixes: Fix[] = [];
    private dynamics = new Map<string, Position[]>();
    private trailLoaded = false;
    private lastFixStamp = "";
    private lastMowerState: string | null = null;
    private idleSince: number | null = null;

    private ticks = 0;
    private loading = false;
    private lastError: string | null = null;
    private timer: ReturnType<typeof setInterval> | null = null;
    private observer: ResizeObserver | null = null;

    setConfig(config: Partial<CardConfig> & { entity?: string }): void {
        if (!config.entity) {
            throw new Error("mammotion-map-card: 'entity' is required (your lawn_mower.* entity)");
        }

        if (!config.entity.startsWith("lawn_mower.")) {
            throw new Error("mammotion-map-card: 'entity' must be a lawn_mower.* entity");
        }

        this.config = { ...DEFAULTS, ...config, entity: config.entity };
        this.staticData = null;
        this.progressData = null;
        this.routeData = null;
        this.resetTrail();
        this.trailLoaded = false;
        this.lastMowerState = null;
        this.idleSince = null;
        this.ticks = 0;
        this.lastError = null;
        this.build();
    }

    set hass(hass: Hass) {
        const first = this.hassObj === null;

        this.hassObj = hass;
        this.trackMower();

        if (first) {
            this.start();
        } else {
            this.render();
        }
    }

    getCardSize(): number {
        return 6;
    }

    connectedCallback(): void {
        if (this.hassObj) {
            this.start();
        }

        if (!this.observer) {
            this.observer = new ResizeObserver(() => this.render());
            this.observer.observe(this.canvas);
        }
    }

    disconnectedCallback(): void {
        this.stop();

        if (this.observer) {
            this.observer.disconnect();
            this.observer = null;
        }
    }

    private build(): void {
        const root = this.shadowRoot ?? this.attachShadow({ mode: "open" });

        root.innerHTML = `
            <style>
                ha-card { overflow: hidden; }
                .canvas {
                    position: relative;
                    width: 100%;
                    aspect-ratio: 1 / 1;
                }
                svg { position: absolute; inset: 0; width: 100%; height: 100%; display: block; }
                .msg {
                    position: absolute; inset: 0;
                    display: flex; align-items: center; justify-content: center;
                    padding: 8px; text-align: center;
                    color: var(--secondary-text-color); font-size: 14px;
                }
                .feat { stroke: var(--primary-text-color); }
                .label {
                    fill: var(--primary-text-color);
                    font-family: var(--paper-font-body1_-_font-family, sans-serif);
                    font-size: 12px; font-weight: 500;
                    text-anchor: middle; dominant-baseline: middle;
                    paint-order: stroke;
                    stroke: var(--ha-card-background, var(--card-background-color));
                    stroke-width: 3px; stroke-linejoin: round;
                    pointer-events: none;
                }
                .sub { font-size: 10px; font-weight: 400; opacity: 0.75; }
                .dock { fill: var(--state-icon-color, var(--primary-text-color)); opacity: 0.85; }
                .dock-bolt { fill: var(--ha-card-background, var(--card-background-color)); }
                .mower-halo { fill: var(--primary-color); opacity: 0.22; }
                .mower {
                    fill: var(--primary-color);
                    stroke: var(--ha-card-background, var(--card-background-color));
                    stroke-width: 1.5px;
                }
                .accuracy { fill: var(--primary-color); opacity: 0.1; }
                .route {
                    fill: none; stroke: var(--primary-text-color);
                    stroke-width: 1px; stroke-opacity: 0.25;
                    stroke-linecap: round; stroke-linejoin: round;
                }
                .trail {
                    fill: none; stroke: var(--primary-color); opacity: 0.4;
                    stroke-linecap: round; stroke-linejoin: round;
                }
            </style>
            <ha-card>
                <div class="canvas">
                    <svg xmlns="http://www.w3.org/2000/svg"></svg>
                    <div class="msg"></div>
                </div>
            </ha-card>`;

        this.card = root.querySelector("ha-card")!;
        this.canvas = root.querySelector(".canvas")!;
        this.svg = root.querySelector("svg")!;
        this.message = root.querySelector(".msg")!;

        if (this.config.title) {
            this.card.setAttribute("header", this.config.title);
        }

        this.setMessage("Loading map\u2026");
    }

    private setMessage(text: string): void {
        this.message.textContent = text;
    }

    private start(): void {
        if (this.timer) {
            return;
        }

        void this.refresh(true);

        if (!this.trailLoaded) {
            this.trailLoaded = true;
            void this.loadTrail();
        }

        const period = Math.max(MIN_INTERVAL_S, num(this.config.progress_interval, 180)) * 1000;

        this.timer = setInterval(() => void this.refresh(false), period);
    }

    private stop(): void {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
    }

    private async refresh(force: boolean): Promise<void> {
        if (this.loading || !this.hassObj) {
            return;
        }

        this.loading = true;

        const active = this.mowerActive();

        // get_geojson also (re)starts the mower's 5-minute report stream,
        // which drops the tracker from minutes to ~5 s between fixes.  While
        // a job runs, re-arm it every tick so the trail stays dense.
        const wantStatic = force || this.staticData === null || this.ticks % STATIC_EVERY === 0 ||
            (active && this.config.show_trail && this.config.tracker !== null);

        this.ticks += 1;

        try {
            if (wantStatic) {
                const collection = await this.fetchCollection("get_geojson");

                if (collection) {
                    this.staticData = collection;
                }
            }

            // Over the cloud nothing refreshes the dynamics line or fetches the
            // planned route unless asked.  The reply lands asynchronously and
            // is picked up by the next tick.
            if (active && (this.config.show_route || this.config.show_progress || this.config.show_trail)) {
                await this.hassObj.callWS({
                    type: "call_service",
                    domain: "mammotion",
                    service: "fetch_mow_path",
                    service_data: { entity_id: this.config.entity }
                }).catch((error: unknown) => console.debug("[mammotion-map-card] fetch_mow_path failed:", error));
            }

            if (this.config.show_route) {
                const collection = await this.fetchCollection("get_mow_path_geojson");

                if (collection) {
                    this.routeData = collection;
                }
            }

            if (this.config.show_progress || this.config.show_trail) {
                const collection = await this.fetchCollection("get_mow_progress_geojson");

                if (collection) {
                    this.progressData = collection;
                    this.absorbDynamics(collection);
                }
            }

            this.lastError = null;
        } catch (error) {
            // Keep the last good render.  A failed poll must never cancel the
            // timer, or one cloud hiccup freezes the map until a page reload.
            this.lastError = error instanceof Error ? error.message : String(error);
            console.warn("[mammotion-map-card] refresh failed:", error);
        } finally {
            this.loading = false;
            this.render();
        }
    }

    private async fetchCollection(service: string): Promise<FeatureCollection | null> {
        const result = await this.hassObj!.callWS<{ response?: FeatureCollection }>({
            type: "call_service",
            domain: "mammotion",
            service,
            service_data: { entity_id: this.config.entity },
            return_response: true
        });

        const collection = result.response;

        return collection && Array.isArray(collection.features) ? collection : null;
    }

    private mowerActive(): boolean {
        const state = this.hassObj?.states[this.config.entity]?.state ?? "";

        return ACTIVE_STATES.includes(state);
    }

    private resetTrail(): void {
        this.fixes = [];
        this.dynamics.clear();
        this.lastFixStamp = "";
    }

    /** Follows the live entities: resets the trail when a job starts, appends tracker fixes during one. */
    private trackMower(): void {
        if (!this.config.show_trail || !this.hassObj) {
            return;
        }

        const state = this.hassObj.states[this.config.entity]?.state ?? null;
        const now = Date.now() / 1000;

        if (state !== this.lastMowerState) {
            if (!ACTIVE_STATES.includes(state ?? "")) {
                this.idleSince ??= now;
            } else {
                if (state === "mowing" && this.idleSince !== null && now - this.idleSince > JOB_GAP_S) {
                    this.resetTrail();
                }

                this.idleSince = null;
            }
        }

        this.lastMowerState = state;

        if (!this.config.tracker || !ACTIVE_STATES.includes(state ?? "")) {
            return;
        }

        const tracker = this.hassObj.states[this.config.tracker];

        if (!tracker || tracker.last_updated === this.lastFixStamp) {
            return;
        }

        this.lastFixStamp = tracker.last_updated;
        this.addFix(Date.parse(tracker.last_updated) / 1000, tracker.attributes);
    }

    private addFix(t: number, attributes: Record<string, unknown> | undefined): void {
        const lat = attributes?.latitude;
        const lon = attributes?.longitude;

        if (typeof lat !== "number" || typeof lon !== "number" || !Number.isFinite(t)) {
            return;
        }

        const last = this.fixes[this.fixes.length - 1];

        // The tracker re-reports an unchanged position several times a second
        // while the stream runs; only movement is kept.
        if (last && last.lat === lat && last.lon === lon) {
            last.t = Math.max(last.t, t);

            return;
        }

        if (last && t < last.t) {
            return;
        }

        this.fixes.push({ t, lon, lat });
    }

    private absorbDynamics(collection: FeatureCollection): void {
        if (!this.config.show_trail) {
            return;
        }

        for (const feature of collection.features) {
            const geometry = feature.geometry;

            if (feature.properties?.type_name !== "dynamics_line" || geometry?.type !== "LineString") {
                continue;
            }

            const line = geometry.coordinates;

            if (line.length < 2) {
                continue;
            }

            const key = line[0].join(",");
            const known = this.dynamics.get(key);

            if (!known || known.length < line.length) {
                this.dynamics.set(key, line);
            }
        }
    }

    /**
     * Rebuilds the current (or last) job's trail from the recorder, so a page
     * reload mid-job does not start from a blank lawn.
     */
    private async loadTrail(): Promise<void> {
        if (!this.config.show_trail || !this.config.tracker || !this.hassObj) {
            return;
        }

        const now = Date.now() / 1000;
        const since = new Date((now - TRAIL_LOOKBACK_H * 3600) * 1000).toISOString();

        try {
            const mower = await this.hassObj.callWS<Record<string, HistoryRow[] | undefined>>({
                type: "history/history_during_period",
                start_time: since,
                entity_ids: [this.config.entity],
                minimal_response: true,
                no_attributes: true,
                significant_changes_only: false
            });

            const rows = mower[this.config.entity] ?? [];
            let start: number | null = null;
            let end: number | null = null;

            for (let i = 0; i < rows.length; i += 1) {
                const row = rows[i];
                const previous = i > 0 ? rows[i - 1] : null;
                const fresh = previous === null ||
                    (!ACTIVE_STATES.includes(previous.s) && row.lu - previous.lu > JOB_GAP_S);

                if (row.s === "mowing" && fresh) {
                    start = row.lu;
                    end = null;
                } else if (row.s === "mowing" && previous !== null && !ACTIVE_STATES.includes(previous.s)) {
                    end = null;
                } else if (start !== null && end === null && !ACTIVE_STATES.includes(row.s)) {
                    end = row.lu;
                }
            }

            if (start === null) {
                return;
            }

            const tracker = await this.hassObj.callWS<Record<string, HistoryRow[] | undefined>>({
                type: "history/history_during_period",
                start_time: new Date(start * 1000).toISOString(),
                end_time: new Date((end ?? now) * 1000).toISOString(),
                entity_ids: [this.config.tracker],
                minimal_response: false,
                no_attributes: false,
                significant_changes_only: false
            });

            const live = this.fixes;

            this.fixes = [];

            for (const row of tracker[this.config.tracker] ?? []) {
                this.addFix(row.lu, row.a);
            }

            // Fixes that arrived live while the history query was in flight.
            for (const fix of live) {
                this.addFix(fix.t, { latitude: fix.lat, longitude: fix.lon });
            }

            this.render();
        } catch (error) {
            console.warn("[mammotion-map-card] trail history unavailable:", error);
        }
    }

    private visibleFeatures(): { statics: Feature[]; progress: Feature[]; route: Feature[] } {
        const hiddenTypes = new Set(this.config.hide_types.map((value) => value.toLowerCase()));
        const hiddenNames = new Set(this.config.hide_names.map((value) => value.toLowerCase()));

        const keep = (feature: Feature): boolean => {
            const props = feature.properties ?? {};

            if (hiddenTypes.has((props.type_name ?? "").toLowerCase())) {
                return false;
            }

            return !hiddenNames.has(featureName(props).toLowerCase());
        };

        return {
            statics: (this.staticData?.features ?? []).filter(keep),
            progress: this.config.show_progress ? (this.progressData?.features ?? []).filter(keep) : [],
            route: this.config.show_route
                ? (this.routeData?.features ?? [])
                    .filter((feature) => ROUTE_TYPES.includes(feature.properties?.type_name ?? ""))
                    .filter(keep)
                : []
        };
    }

    private mowerFix(): MowerFix | null {
        if (!this.config.tracker || !this.hassObj) {
            return null;
        }

        const entity = this.hassObj.states[this.config.tracker];

        if (!entity) {
            return null;
        }

        const lat = entity.attributes.latitude;
        const lon = entity.attributes.longitude;

        if (typeof lat !== "number" || typeof lon !== "number") {
            return null;
        }

        return {
            lat,
            lon,
            heading: num(entity.attributes.direction, 0),
            accuracy: num(entity.attributes.gps_accuracy, 0),
            state: entity.state
        };
    }

    private render(): void {
        if (!this.svg) {
            return;
        }

        const { statics, progress, route } = this.visibleFeatures();
        const mower = this.mowerFix();

        if (statics.length === 0 && progress.length === 0) {
            this.svg.innerHTML = "";
            this.setMessage(this.lastError !== null
                ? `Map unavailable \u2014 ${this.lastError}`
                : "No map data.  Sync the map in the Mammotion app.");

            return;
        }

        const rect = this.canvas.getBoundingClientRect();
        const width = rect.width;
        const height = rect.height;

        if (width === 0 || height === 0) {
            return;
        }

        let minLat = Infinity;
        let maxLat = -Infinity;
        let minLon = Infinity;
        let maxLon = -Infinity;

        const extend = ([lon, lat]: Position): void => {
            if (!Number.isFinite(lon) || !Number.isFinite(lat)) {
                return;
            }

            minLat = Math.min(minLat, lat);
            maxLat = Math.max(maxLat, lat);
            minLon = Math.min(minLon, lon);
            maxLon = Math.max(maxLon, lon);
        };

        for (const feature of [...statics, ...progress]) {
            eachPosition(feature.geometry, extend);
        }

        // The mower joins the bounds so it is never clipped if it strays
        // outside the mapped zones.
        if (mower) {
            extend([mower.lon, mower.lat]);
        }

        if (!Number.isFinite(minLat)) {
            return;
        }

        const midLat = (minLat + maxLat) / 2;
        const midLon = (minLon + maxLon) / 2;
        const lonScale = M_PER_DEG_LON * Math.cos((midLat * Math.PI) / 180);
        const spanX = Math.max((maxLon - minLon) * lonScale, 0.5);
        const spanY = Math.max((maxLat - minLat) * M_PER_DEG_LAT, 0.5);

        // The card takes the shape of the plot, within sane limits.
        this.canvas.style.aspectRatio = `${Math.min(2, Math.max(0.55, spanX / spanY))} / 1`;

        const pad = num(this.config.padding, 18);
        const scale = Math.min((width - 2 * pad) / spanX, (height - 2 * pad) / spanY);
        const toX = (lon: number): number => width / 2 + (lon - midLon) * lonScale * scale;
        const toY = (lat: number): number => height / 2 - (lat - midLat) * M_PER_DEG_LAT * scale;

        const ofType = (type: string): Feature[] =>
            statics.filter((feature) => (feature.properties?.type_name ?? "") === type);

        // Route and trail stay out of the bounds: they live inside the zones,
        // and one stray GPS fix must not reframe the whole map.
        const parts: string[] = ofType("area").map((feature) => this.drawFeature(feature, toX, toY));

        for (const feature of route) {
            parts.push(this.drawRoute(feature, toX, toY));
        }

        if (this.config.show_trail) {
            parts.push(this.drawTrail(toX, toY, scale));
        }

        const ordered = [
            ...progress,
            ...ofType("path"),
            ...ofType("obstacle"),
            ...statics.filter((feature) => !STACKED.includes(feature.properties?.type_name ?? ""))
        ];

        for (const feature of ordered) {
            parts.push(this.drawFeature(feature, toX, toY));
        }

        for (const feature of ofType("station")) {
            parts.push(this.drawStation(feature, toX, toY));
        }

        if (this.config.show_labels) {
            for (const feature of ofType("area")) {
                parts.push(this.drawLabel(feature, toX, toY));
            }
        }

        if (mower) {
            parts.push(this.drawMower(mower, toX, toY, scale));
        }

        this.svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
        this.svg.innerHTML = parts.filter(Boolean).join("");
        this.setMessage(this.lastError !== null ? `Stale \u2014 ${this.lastError}` : "");
    }

    private drawFeature(feature: Feature, toX: (lon: number) => number, toY: (lat: number) => number): string {
        const props = feature.properties ?? {};
        const geometry = feature.geometry;

        if (!geometry) {
            return "";
        }

        // CSS variables are not valid in presentation attributes, so an absent
        // colour falls through to the .feat class instead of an inline value.
        const stroke = `${props.color ? ` stroke="${esc(props.color)}"` : ""}` +
            ` stroke-width="${num(props.weight, 2)}"` +
            ` stroke-opacity="${num(props.opacity, 1)}"` +
            ` stroke-linecap="${esc(props.lineCap ?? "round")}"` +
            ` stroke-linejoin="${esc(props.lineJoin ?? "round")}"` +
            `${props.dashArray ? ` stroke-dasharray="${esc(props.dashArray)}"` : ""}`;

        const name = featureName(props);
        const tip = name
            ? `<title>${esc(name)}${props.area ? ` \u2014 ${Math.ceil(props.area)} m\u00b2` : ""}</title>`
            : "";

        const points = (ring: Position[]): string =>
            ring.map(([lon, lat]) => `${toX(lon).toFixed(2)},${toY(lat).toFixed(2)}`).join(" ");
        const ringPath = (ring: Position[]): string =>
            `${ring.map(([lon, lat], i) => `${i ? "L" : "M"}${toX(lon).toFixed(2)},${toY(lat).toFixed(2)}`).join(" ")} Z`;

        if (geometry.type === "Polygon" || geometry.type === "MultiPolygon") {
            const polygons = geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
            const d = polygons.map((rings) => rings.map(ringPath).join(" ")).join(" ");
            const fill = props.fillColor ? ` fill="${esc(props.fillColor)}"` : " fill=\"none\"";

            return `<path class="feat" d="${d}"${fill} fill-opacity="${num(props.fillOpacity, 0.3)}"` +
                ` fill-rule="evenodd"${stroke}>${tip}</path>`;
        }

        if (geometry.type === "LineString" || geometry.type === "MultiLineString") {
            const lines = geometry.type === "LineString" ? [geometry.coordinates] : geometry.coordinates;

            return lines
                .map((line) => `<polyline class="feat" points="${points(line)}" fill="none"${stroke}>${tip}</polyline>`)
                .join("");
        }

        return "";
    }

    /** The planned route: hairline stripes, themed rather than the integration's green. */
    private drawRoute(feature: Feature, toX: (lon: number) => number, toY: (lat: number) => number): string {
        const geometry = feature.geometry;

        if (geometry?.type !== "LineString" && geometry?.type !== "MultiLineString") {
            return "";
        }

        const lines = geometry.type === "LineString" ? [geometry.coordinates] : geometry.coordinates;
        const d = lines
            .map((line) => line.map(([lon, lat], i) => `${i ? "L" : "M"}${toX(lon).toFixed(1)},${toY(lat).toFixed(1)}`).join(""))
            .join("");

        return `<path class="route" d="${d}"/>`;
    }

    /**
     * The mown trail as one stroked path, blade-width wide.  A single element
     * keeps overlapping passes from darkening each other, so it reads as
     * "cut area" rather than a scribble.
     */
    private drawTrail(toX: (lon: number) => number, toY: (lat: number) => number, scale: number): string {
        const runs: Position[][] = [...this.dynamics.values()];
        let run: Position[] = [];
        let lastT = -Infinity;

        for (const fix of this.fixes) {
            if (fix.t - lastT > TRAIL_GAP_S) {
                runs.push(run);
                run = [];
            }

            run.push([fix.lon, fix.lat]);
            lastT = fix.t;
        }

        runs.push(run);

        const d = runs
            .filter((line) => line.length > 1)
            .map((line) => line.map(([lon, lat], i) => `${i ? "L" : "M"}${toX(lon).toFixed(1)},${toY(lat).toFixed(1)}`).join(""))
            .join("");

        if (!d) {
            return "";
        }

        const width = Math.max(2, num(this.config.trail_width, 0.22) * scale);

        return `<path class="trail" d="${d}" stroke-width="${width.toFixed(1)}"/>`;
    }

    private drawStation(feature: Feature, toX: (lon: number) => number, toY: (lat: number) => number): string {
        const geometry = feature.geometry;

        if (!geometry || geometry.type !== "Point") {
            return "";
        }

        const [lon, lat] = geometry.coordinates;
        const name = featureName(feature.properties ?? {}) || "Station";

        return `<g transform="translate(${toX(lon).toFixed(2)},${toY(lat).toFixed(2)})">` +
            `<title>${esc(name)}</title>` +
            "<rect class=\"dock\" x=\"-9\" y=\"-9\" width=\"18\" height=\"18\" rx=\"4\"/>" +
            "<path class=\"dock-bolt\" d=\"M 1.5,-6 L -4,1 L -0.5,1 L -1.5,6 L 4,-1 L 0.5,-1 Z\"/>" +
            "</g>";
    }

    private drawLabel(feature: Feature, toX: (lon: number) => number, toY: (lat: number) => number): string {
        const props = feature.properties ?? {};
        const name = featureName(props);

        if (!name) {
            return "";
        }

        let sumX = 0;
        let sumY = 0;
        let count = 0;

        eachPosition(feature.geometry, ([lon, lat]) => {
            sumX += toX(lon);
            sumY += toY(lat);
            count += 1;
        });

        if (count === 0) {
            return "";
        }

        const x = (sumX / count).toFixed(2);
        const y = (sumY / count).toFixed(2);
        const area = props.area
            ? `<tspan class="sub" x="${x}" dy="14">${Math.ceil(props.area)} m\u00b2</tspan>`
            : "";

        return `<text class="label" x="${x}" y="${y}">${esc(name)}${area}</text>`;
    }

    private drawMower(
        mower: MowerFix,
        toX: (lon: number) => number,
        toY: (lat: number) => number,
        scale: number
    ): string {
        const x = toX(mower.lon).toFixed(2);
        const y = toY(mower.lat).toFixed(2);
        const accuracy = mower.accuracy > 0
            ? `<circle class="accuracy" cx="${x}" cy="${y}" r="${Math.max(6, mower.accuracy * scale).toFixed(2)}"/>`
            : "";

        return `${accuracy}<g transform="translate(${x},${y}) rotate(${mower.heading})">` +
            `<title>${esc(this.config.entity)} \u2014 ${esc(mower.state)}</title>` +
            "<circle class=\"mower-halo\" r=\"15\"/>" +
            "<path class=\"mower\" d=\"M 0,-12 L 8.5,8 L 0,3.5 L -8.5,8 Z\"/>" +
            "</g>";
    }
}

customElements.define("mammotion-map-card", MammotionMapCard);

interface CustomCard {
    type: string;
    name: string;
    description: string;
    preview: boolean;
}

const registry = window as unknown as { customCards?: CustomCard[] };

registry.customCards ??= [];
registry.customCards.push({
    type: "mammotion-map-card",
    name: "Mammotion Map Card",
    description: "Vacuum-style zone map for Mammotion mowers, drawn from the integration's GeoJSON.",
    preview: false
});

console.info(
    `%c MAMMOTION-MAP-CARD %c ${__VERSION__} %c ${__BUILD_ID__} `,
    "color:#08301a;background:#8ad08a;font-weight:700",
    "color:#8ad08a;background:#08301a;font-weight:700",
    "color:inherit;background:inherit"
);
