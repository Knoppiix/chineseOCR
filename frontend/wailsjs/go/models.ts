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

}

