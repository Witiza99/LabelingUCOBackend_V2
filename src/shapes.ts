export interface Rectangle {
    type: 'rectangle';
    x: number;
    y: number;
    width: number;
    height: number;
    color: string;
    label: string;
    thickness: number;
}

export interface Polygon {
    type: 'polygon';
    points: { x: number; y: number }[];
    color: string;
    label: string;
    thickness: number;
}

export interface Circle {
    type: 'circle';
    cx: number;
    cy: number;
    radius: number;
    color: string;
    label: string;
    thickness: number;
}

export type Shape = Rectangle | Polygon | Circle;
