/**
 * WebRTC mesh voice for lobby (≤6 peers). Signaling via RoomHub sendVoiceSignal / voice_signal events.
 * Uses public STUN only; add TURN for strict NAT (future).
 */
const ICE: RTCIceServer[] = [{ urls: 'stun:stun.l.google.com:19302' }];

export type VoiceSignalSender = (
  toSessionId: string,
  kind: 'offer' | 'answer' | 'candidate',
  sdp?: string,
  candidate?: RTCIceCandidateInit,
) => void;

export class LobbyVoiceMesh {
  private readonly sendSignal: VoiceSignalSender;
  private readonly audioMount: HTMLElement;
  private localStream: MediaStream | null = null;
  private readonly pcs = new Map<string, RTCPeerConnection>();
  private readonly audios = new Map<string, HTMLAudioElement>();
  private readonly pendingIce = new Map<string, RTCIceCandidateInit[]>();
  private lastLocalId: string | null = null;
  private lastPeerIds: string[] = [];

  constructor(opts: { sendSignal: VoiceSignalSender; audioMount: HTMLElement }) {
    this.sendSignal = opts.sendSignal;
    this.audioMount = opts.audioMount;
  }

  /** Call when room membership changes. */
  syncPeers(localId: string | null, peerSessionIds: string[]): void {
    this.lastLocalId = localId;
    this.lastPeerIds = peerSessionIds;
    if (!localId) {
      this.disposePeers();
      return;
    }
    const want = new Set(peerSessionIds.filter((id) => id && id !== localId));
    for (const id of [...this.pcs.keys()]) {
      if (!want.has(id)) this.removePeer(id);
    }
    for (const remoteId of want) {
      if (!this.pcs.has(remoteId) && localId < remoteId) {
        void this.createOffererPc(remoteId);
      }
    }
  }

  /** Enable / disable capture. After toggling, mesh is rebuilt so offers are re-sent. */
  async setMicEnabled(on: boolean): Promise<void> {
    if (on) {
      try {
        this.localStream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true },
          video: false,
        });
      } catch (e) {
        console.warn('getUserMedia failed', e);
        throw e;
      }
    } else {
      this.localStream?.getTracks().forEach((t) => t.stop());
      this.localStream = null;
    }
    this.rebuildMesh();
  }

  getMicOn(): boolean {
    return !!this.localStream?.getAudioTracks().some((t) => t.readyState === 'live');
  }

  /** Re-run offers after connection issues or late permission. */
  reconnect(): void {
    this.rebuildMesh();
  }

  async handleSignal(
    fromSessionId: string,
    kind: 'offer' | 'answer' | 'candidate',
    sdp: string | null,
    candidate: RTCIceCandidateInit | null,
  ): Promise<void> {
    if (kind === 'offer' && sdp) {
      await this.onOffer(fromSessionId, sdp);
      return;
    }
    if (kind === 'answer' && sdp) {
      await this.onAnswer(fromSessionId, sdp);
      return;
    }
    if (kind === 'candidate' && candidate) {
      await this.onCandidate(fromSessionId, candidate);
    }
  }

  dispose(): void {
    this.disposePeers();
    this.localStream?.getTracks().forEach((t) => t.stop());
    this.localStream = null;
    this.lastLocalId = null;
    this.lastPeerIds = [];
    this.audioMount.replaceChildren();
  }

  private rebuildMesh(): void {
    const localId = this.lastLocalId;
    const peers = this.lastPeerIds;
    if (!localId) return;
    for (const id of [...this.pcs.keys()]) {
      this.removePeer(id);
    }
    const want = new Set(peers.filter((id) => id && id !== localId));
    for (const remoteId of want) {
      if (localId < remoteId) {
        void this.createOffererPc(remoteId);
      }
    }
  }

  private disposePeers(): void {
    for (const id of [...this.pcs.keys()]) {
      this.removePeer(id);
    }
  }

  private removePeer(remoteId: string): void {
    const pc = this.pcs.get(remoteId);
    if (pc) {
      pc.close();
      this.pcs.delete(remoteId);
    }
    this.pendingIce.delete(remoteId);
    const el = this.audios.get(remoteId);
    if (el) {
      el.remove();
      this.audios.delete(remoteId);
    }
  }

  private makePc(remoteId: string): RTCPeerConnection {
    const pc = new RTCPeerConnection({ iceServers: ICE });
    pc.onicecandidate = (ev) => {
      if (ev.candidate) {
        this.sendSignal(remoteId, 'candidate', undefined, ev.candidate.toJSON());
      }
    };
    pc.ontrack = (ev) => {
      const stream = ev.streams[0] ?? new MediaStream([ev.track]);
      let el = this.audios.get(remoteId);
      if (!el) {
        el = document.createElement('audio');
        el.autoplay = true;
        el.setAttribute('playsinline', '');
        el.setAttribute('data-voice-peer', remoteId);
        this.audioMount.appendChild(el);
        this.audios.set(remoteId, el);
      }
      el.srcObject = stream;
      void el.play().catch(() => {});
    };
    return pc;
  }

  private attachRecvOrSend(pc: RTCPeerConnection): void {
    if (this.localStream) {
      const track = this.localStream.getAudioTracks()[0];
      if (track) {
        pc.addTrack(track, this.localStream);
        return;
      }
    }
    pc.addTransceiver('audio', { direction: 'recvonly' });
  }

  private async createOffererPc(remoteId: string): Promise<void> {
    if (this.pcs.has(remoteId)) return;
    const pc = this.makePc(remoteId);
    this.pcs.set(remoteId, pc);
    this.attachRecvOrSend(pc);
    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      this.sendSignal(remoteId, 'offer', offer.sdp ?? undefined);
    } catch (e) {
      console.warn('voice createOffer failed', e);
    }
  }

  private async onOffer(fromId: string, sdp: string): Promise<void> {
    let pc = this.pcs.get(fromId);
    if (!pc) {
      pc = this.makePc(fromId);
      this.pcs.set(fromId, pc);
      this.attachRecvOrSend(pc);
    }
    try {
      await pc.setRemoteDescription({ type: 'offer', sdp });
      await this.flushIce(fromId);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      this.sendSignal(fromId, 'answer', answer.sdp ?? undefined);
      await this.flushIce(fromId);
    } catch (e) {
      console.warn('voice onOffer failed', e);
    }
  }

  private async onAnswer(fromId: string, sdp: string): Promise<void> {
    const pc = this.pcs.get(fromId);
    if (!pc) return;
    try {
      await pc.setRemoteDescription({ type: 'answer', sdp });
      await this.flushIce(fromId);
    } catch (e) {
      console.warn('voice onAnswer failed', e);
    }
  }

  private async onCandidate(fromId: string, candidate: RTCIceCandidateInit): Promise<void> {
    const pc = this.pcs.get(fromId);
    if (!pc) {
      const q = this.pendingIce.get(fromId) ?? [];
      q.push(candidate);
      this.pendingIce.set(fromId, q);
      return;
    }
    if (!pc.remoteDescription) {
      const q = this.pendingIce.get(fromId) ?? [];
      q.push(candidate);
      this.pendingIce.set(fromId, q);
      return;
    }
    try {
      await pc.addIceCandidate(candidate);
    } catch {
      /* ignore stale candidates */
    }
  }

  private async flushIce(peerId: string): Promise<void> {
    const pc = this.pcs.get(peerId);
    const q = this.pendingIce.get(peerId);
    if (!pc || !q?.length) return;
    this.pendingIce.delete(peerId);
    for (const c of q) {
      try {
        await pc.addIceCandidate(c);
      } catch {
        /* ignore */
      }
    }
  }
}
