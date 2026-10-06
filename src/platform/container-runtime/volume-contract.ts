export interface VolumeRemovalRequest {
  readonly name: string;
}

export interface VolumeOperations {
  exists(name: string): Promise<boolean>;
  create(name: string): Promise<void>;
  remove(request: VolumeRemovalRequest): Promise<void>;
}
