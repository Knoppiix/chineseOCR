export namespace main {
	
	export class Config {
	    overlayHotkey: string;
	    captureHotkey: string;
	    dictPath: string;
	    overlayMinConfidence: number;
	    detectionMaxSide: number;
	    captureDisplay: number;
	
	    static createFrom(source: any = {}) {
	        return new Config(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.overlayHotkey = source["overlayHotkey"];
	        this.captureHotkey = source["captureHotkey"];
	        this.dictPath = source["dictPath"];
	        this.overlayMinConfidence = source["overlayMinConfidence"];
	        this.detectionMaxSide = source["detectionMaxSide"];
	        this.captureDisplay = source["captureDisplay"];
	    }
	}
	export class DisplayInfo {
	    index: number;
	    x: number;
	    y: number;
	    width: number;
	    height: number;
	    primary: boolean;
	
	    static createFrom(source: any = {}) {
	        return new DisplayInfo(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.index = source["index"];
	        this.x = source["x"];
	        this.y = source["y"];
	        this.width = source["width"];
	        this.height = source["height"];
	        this.primary = source["primary"];
	    }
	}
	export class FrameMeta {
	    data: string;
	    durationMs: number;
	
	    static createFrom(source: any = {}) {
	        return new FrameMeta(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.data = source["data"];
	        this.durationMs = source["durationMs"];
	    }
	}
	export class SessionMeta {
	    id: string;
	    savedAt: string;
	    frames: number;
	    words: number;
	
	    static createFrom(source: any = {}) {
	        return new SessionMeta(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.savedAt = source["savedAt"];
	        this.frames = source["frames"];
	        this.words = source["words"];
	    }
	}
	export class SessionWord {
	    word: string;
	    count: number;
	    ms: number;
	
	    static createFrom(source: any = {}) {
	        return new SessionWord(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.word = source["word"];
	        this.count = source["count"];
	        this.ms = source["ms"];
	    }
	}
	export class SessionRecord {
	    id: string;
	    savedAt: string;
	    frames: number;
	    words: SessionWord[];
	
	    static createFrom(source: any = {}) {
	        return new SessionRecord(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.savedAt = source["savedAt"];
	        this.frames = source["frames"];
	        this.words = this.convertValues(source["words"], SessionWord);
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}

}

