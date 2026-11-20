/**
 * What the globe is given to draw. Deliberately only places and the links
 * between them: no liquidity, availability or status field exists, so the
 * component cannot show any.
 */
export type GlobeLocation = {
  id: string;
  /** Display name, used for the text alternative. */
  name: string;
  /** Degrees, north positive. */
  lat: number;
  /** Degrees, east positive. */
  lon: number;
};

export type GlobeConnection = {
  id: string;
  /** Ids of two entries in `locations`. */
  from: string;
  to: string;
};
