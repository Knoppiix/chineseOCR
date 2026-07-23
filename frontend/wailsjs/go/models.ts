export namespace main {
	
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

