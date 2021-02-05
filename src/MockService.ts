interface Feature<T> {
  attributes: { [key: string]: string | number },
  geometry: T;
}


interface PointFeature {
  attributes: { [key: string]: string | number },
  geometry: {
    x: number,
    y: number;
  }
}

interface PolygonFeature {
  attributes: { [key: string]: string | number },
  geometry: {
    rings: number[][][]
  }
}

export interface Polyline {
  paths: number[][][];
}

export interface FeatureSet<T> {
  features: Feature<T>[];
}

export interface MockServiceConfig {
  trackedAssets: number,
  pageSize: number,
  distStep: number
}

const getAzimuth = (dx: number, dy: number) => Math.atan2(dy, dx) - Math.PI / 2;
const getIsActive = () => Math.random() < 0.05 ? 1 : 0;

const NumCyclesBetweenActiveUpdate = 400;

/** 
 * MockService that will output either point or polygon features with a geometry and 
 * two attributes - a TRACKID and OBJECTID
 */
export class MockService {
  constructor(config: Partial<MockServiceConfig>) {
    this._config = {...MockService._defaults(), ...config }
  };

  private static _defaults(): MockServiceConfig {
    return {
      trackedAssets: 10000,  // number of points
      pageSize: 10000,       // how many points to update in one cycle
      distStep: 0.01 * 2       // speed, as percentage of the segment
    }
  }

  private _idCounter = 0x1;
  private _page = 0;
  private _config: MockServiceConfig
  private _lastObservations: PointFeature[] = [];
  private _trackInfos: number[] = []
  private _polylines: FeatureSet<Polyline>
  private _numCyclesSinceLastActiveUpdate = 0;

  initialize(polylines: FeatureSet<Polyline>): void {
    this._polylines = polylines;
    this._initialize(polylines);
  }

  next(): string {
    const polylines = this._polylines;
    const { pageSize, trackedAssets } = this._config;
    const start = this._nextPage() * pageSize;
    const end = Math.min(start + pageSize, trackedAssets);
    const outFeatures: (PointFeature | PolygonFeature)[] = new Array<PointFeature | PolygonFeature>(end - start);
    
    if (start === 0) {
      this._updatePositions(polylines);
    }
    
    const lastObservations = this._lastObservations;
    for (let i = start; i < end; i++) {
      outFeatures[i] = lastObservations[i];
    }

    return JSON.stringify({
      type: "featureResult",
      features: outFeatures
    });
  }

  private _initialize(polylines: FeatureSet<Polyline>): void {
    const vertexSum = this._sumPolylineVertices(polylines);    
    const trackInfos = this._trackInfos;
    const config = this._config;
    const numOfTrackedAssets = config.trackedAssets;    

    let heading: number;
    let featureIndex = 0;
    let trackIndex = 0;    
    while (trackIndex < numOfTrackedAssets) {  
      const feature = polylines.features[featureIndex];
      if (!feature) {
        console.log(`index out of bounds! Feature Index is ${featureIndex}. Num of tracks is: ${trackIndex}`);
        break;
      }
      
      const polyline = feature.geometry;
      const numberOfVertices = this._getNumberOfVertices(polyline);      
      const numOfTracksPerFeature = Math.max(Math.floor(numOfTrackedAssets * numberOfVertices / vertexSum), 1);
      const vertexNumBetweenTracks = Math.floor(0.8 * numberOfVertices / numOfTracksPerFeature);      

      let currentPath = 0;
      let currentVertex = 0;
      for (let numTrack = 0; numTrack < numOfTracksPerFeature; numTrack++) {
        let path = polyline.paths[currentPath];        

        const vertex = path[currentVertex];
        const vertexNext = path[currentVertex + 1];        
        
        const x0 = vertex[0];
        const y0 = vertex[1];
        const x1 = vertexNext[0];
        const y1 = vertexNext[1];
        const dist = Math.sqrt((x1 - x0) * (x1 - x0) + (y1 - y0) * (y1 - y0));
        const speed = dist * config.distStep;
              
        trackInfos.push(
          featureIndex, // feature index
          currentPath,    // path index
          currentVertex,    // current vertex index
          dist, // distance to the next vertex 
          0,    // accumulated distance (to the next vertex)
          speed, // speed
          );
        
        this._lastObservations.push({
          attributes: {
            OBJECTID: this._createId(),            
            TRACKID: trackIndex++,
            HEADING: getAzimuth(x1 - x0, y1 - y0),
            TYPE: Math.round(Math.random() * 5),
            ACTIVE: getIsActive()
          },
          geometry: { x: x0, y: y0 }
        });
        
        const nextStart = this._getNextTrackStart(polyline, vertexNumBetweenTracks, currentPath, currentVertex);
        if (!nextStart) {          
          break;
        }

        currentPath = nextStart.pathIndex;
        currentVertex = nextStart.vertexIndex;
      }

      currentVertex = 0;
      featureIndex++;
    }
  }

  private _updatePositions(polylines: FeatureSet<Polyline>): void {
    const trackInfos = this._trackInfos;
    this._numCyclesSinceLastActiveUpdate++   
    for (let i = 0; i < trackInfos.length; i += 6) {
      const featureIndex = trackInfos[i];
      let pathIndex = trackInfos[i + 1];
      let vertexIndex = trackInfos[i + 2];
      let distanceToNextVertex = trackInfos[i + 3];
      let accumulatedDistance = trackInfos[i + 4];
      let speed = trackInfos[i + 5];

      
      const paths = polylines.features[featureIndex].geometry.paths;
      let path = paths[pathIndex];
      let vertex = path[vertexIndex];
      let vertexNext = path[vertexIndex + 1];
      let x0 = vertex[0];
      let y0 = vertex[1];
      let x1 = vertexNext[0];
      let y1 = vertexNext[1];      
      const index = i / 6;

      let nextDist = accumulatedDistance + speed;
      const distanceRatio = nextDist / distanceToNextVertex;
      const x = x0 + (x1 - x0) * distanceRatio;
      const y = y0 + (y1 - y0) * distanceRatio;
      
      const geometry = this._lastObservations[index].geometry;
      const attributes = this._lastObservations[index].attributes;

      attributes.OBJECTID = this._createId(); // New observation needs new oid
      attributes.HEADING = getAzimuth(x1 - x0, y1 - y0);

       if (this._numCyclesSinceLastActiveUpdate === NumCyclesBetweenActiveUpdate) {
         attributes.ACTIVE = getIsActive();
       }
      
      geometry.x = x;
      geometry.y = y;

      trackInfos[i + 4] = nextDist
      
      // test if we need to move to the next vertex
      if ((nextDist + speed) >= distanceToNextVertex) {
        
        vertexIndex++;

        // If we reach the end, loop back ground
        if (vertexIndex >= (path.length - 1))  {
          if (pathIndex < (paths.length -1)) {            
            path = paths[pathIndex++];       
          } else {
            pathIndex = 0;
          }

          trackInfos[i + 1] = pathIndex;
          vertexIndex = 0;
        }

        vertex = path[vertexIndex];
        vertexNext = path[vertexIndex + 1];
        x0 = vertex[0];
        y0 = vertex[1];
        x1 = vertexNext[0];
        y1 = vertexNext[1];
        const dist = Math.sqrt((x1 - x0) * (x1 - x0) + (y1 - y0) * (y1 - y0));

        trackInfos[i + 2] = vertexIndex;
        trackInfos[i + 3] = dist;
        trackInfos[i + 4] = 0;        
      }
    }

    if (this._numCyclesSinceLastActiveUpdate >= NumCyclesBetweenActiveUpdate) {
      this._numCyclesSinceLastActiveUpdate = 0;
    }
  }

  private _nextPage (): number {
    const { trackedAssets,  pageSize } = this._config;
    const page = this._page;
    if ((page + 1) * pageSize >= trackedAssets) {
      this._page = 0;
    } else {
      this._page++;
    }

    return page;
  }

  private _createId(): number {
    const id = this._idCounter;
    
    this._idCounter = ((this._idCounter + 1) % 0xfffffffe); // force nonzero u32
    return id;
  }

  private _sumPolylineVertices(polylines: FeatureSet<Polyline>): number {
    let sum = 0;
    
    for (const feature of polylines.features) {
      const paths = feature.geometry.paths;

      for (const path of paths) {
        sum += path.length;
      }
    }

    return sum;
  }

  private _getNumberOfVertices(polyline: Polyline): number {
    const paths = polyline.paths;
    let sum = 0;
    for (const path of paths) {
      sum += path.length;
    }

    return sum;
  }

  private _getNextTrackStart(polyline: Polyline, vertexNumBetweenTracks: number, currentPath: number, currentVertex: number): { pathIndex: number, vertexIndex: number} {
    const path = polyline.paths[currentPath];
    if (vertexNumBetweenTracks + currentVertex < path.length - 1) {
      return { pathIndex: currentPath,  vertexIndex: vertexNumBetweenTracks + currentVertex };
    }

    currentPath++;

    if (currentPath >= polyline.paths.length || polyline.paths[currentPath].length < 2) {            
      return null;
    }

    return { pathIndex: currentPath,  vertexIndex: 0 };
  }
}

