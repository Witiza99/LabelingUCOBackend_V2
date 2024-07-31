import { Shape } from "./shapes";

export interface ImageWithMetadata {
    id: string; //id for each image
    file: Express.Multer.File; // Image is a file
    metadata: Shape[] | null; // Metadata (label, shape (rectangle, circle...), etc.)
}