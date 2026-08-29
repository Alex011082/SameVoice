import {
  type ConnectionQuality,
  ConnectionState,
  type RemoteParticipant,
  type RemoteTrack,
  type RemoteTrackPublication,
  Room,
  RoomEvent,
  Track,
} from 'livekit-client';
import type { AppConfig, CallMode, JoinResponse, StateMessage, SubtitleMessage } from './types';
import { isStateMessage, isSubtitleMessage } from './types';

export type MicFailureKind = 'denied' | 'not_found' | 'insecure_context' | 'unknown';

export interface CallMetrics {
  /** ICE round-trip time to the SFU, in ms. */
  rttMs: number | null;
  /** Receiver-side jitter buffer delay, in ms. */
  jitterBufferMs: number | null;
  /**
   * Client-observed latency of the last subtitle segment: the gap between the
   * first partial and the final for that segment. This is the chunker + MT
   * time as the listener experiences it, NOT true mouth-to-ear latency, which
   * a browser cannot see.
   */
  segmentMs: number | null;
  quality: ConnectionQuality | null;
}

export interface CallHandlers {
  onConnectionState(state: ConnectionState): void;
  onSubtitle(msg: SubtitleMessage): void;
  onAgentState(msg: StateMessage): void;
  onPeerPresence(present: boolean): void;
  onAgentPresence(present: boolean): void;
  /** True when the browser is refusing to start audio without a user gesture. */
  onAudioBlocked(blocked: boolean): void;
  onMicState(state: { enabled: boolean; failure: MicFailureKind | null }): void;
  onMetrics(metrics: CallMetrics): void;
  /** Fired once, for any reason the call is over. `local` = we hung up. */
  onEnded(reason: 'local' | 'peer_left' | 'connection_lost' | 'server'): void;
}

const METRICS_INTERVAL_MS = 2000;

export class CallSession {
  readonly join: JoinResponse;
  readonly mode: CallMode;

  private readonly config: AppConfig;
  private readonly handlers: CallHandlers;
  private readonly audioSink: HTMLElement;

  private room: Room | null = null;
  private metricsTimer: number | null = null;
  private ended = false;
  private hangingUp = false;
  private wasReconnecting = false;
  private micFailure: MicFailureKind | null = null;

  /** segmentId -> wall-clock ms the first partial was seen. */
  private readonly segmentFirstSeen = new Map<string, number>();
  private lastSegmentMs: number | null = null;
  private lastQuality: ConnectionQuality | null = null;

  constructor(opts: {
    join: JoinResponse;
    config: AppConfig;
    audioSink: HTMLElement;
    handlers: CallHandlers;
  }) {
    this.join = opts.join;
    this.mode = opts.join.mode;
    this.config = opts.config;
    this.audioSink = opts.audioSink;
    this.handlers = opts.handlers;
  }

  get connectionState(): ConnectionState {
    return this.room?.state ?? ConnectionState.Disconnected;
  }

  get micEnabled(): boolean {
    return this.room?.localParticipant.isMicrophoneEnabled ?? false;
  }

  get canPlaybackAudio(): boolean {
    return this.room?.canPlaybackAudio ?? true;
  }

  async start(): Promise<void> {
    const room = new Room({
      // Audio-only call: nothing here needs adaptive video machinery.
      adaptiveStream: false,
      dynacast: false,
      disconnectOnPageLeave: false,
      audioCaptureDefaults: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1,
      },
    });
    this.room = room;

    // Handlers must be registered before connect so a message that arrives in
    // the same tick as the join response is not dropped.
    room.registerTextStreamHandler(this.config.subtitleTopic, (reader) => {
      void this.readSubtitle(reader.readAll());
    });
    room.registerTextStreamHandler(this.config.stateTopic, (reader) => {
      void this.readState(reader.readAll());
    });

    this.wireEvents(room);

    await room.connect(this.join.livekitUrl, this.join.token, { autoSubscribe: false });

    // Existing publications are not replayed as TrackPublished events.
    for (const participant of room.remoteParticipants.values()) {
      for (const pub of participant.trackPublications.values()) {
        this.applySubscription(pub, participant);
      }
      this.notifyPresence(participant, true);
    }

    await this.enableMicrophone();

    this.metricsTimer = window.setInterval(() => {
      void this.sampleMetrics();
    }, METRICS_INTERVAL_MS);
    void this.sampleMetrics();
  }

  /**
   * iOS Safari (and Chrome autoplay policy) will not start audio playback
   * without a user gesture. This must be called synchronously from a real
   * click/tap handler.
   */
  async unlockAudio(): Promise<void> {
    if (!this.room) return;
    try {
      await this.room.startAudio();
      this.handlers.onAudioBlocked(!this.room.canPlaybackAudio);
    } catch {
      this.handlers.onAudioBlocked(true);
    }
  }

  async setMuted(muted: boolean): Promise<void> {
    if (!this.room) return;
    if (muted) {
      await this.room.localParticipant.setMicrophoneEnabled(false);
      this.handlers.onMicState({ enabled: false, failure: this.micFailure });
      return;
    }
    await this.enableMicrophone();
  }

  async hangUp(): Promise<void> {
    this.hangingUp = true;
    await this.teardown('local');
  }

  /**
   * Tear down a session whose `start()` threw. Silent on purpose: the call
   * never began, so the "ended" handlers must not run — but the Room must
   * still be disconnected, or livekit-client keeps retrying the connect in the
   * background, joins minutes later, and publishes the microphone into a call
   * the tester has already walked away from.
   */
  async abort(): Promise<void> {
    this.hangingUp = true;
    await this.teardown('local', { silent: true });
  }

  // --- internals ----------------------------------------------------------

  private async enableMicrophone(): Promise<void> {
    if (!this.room) return;
    if (!window.isSecureContext) {
      // http://<lan-ip> is not a secure context; only localhost is exempt.
      // getUserMedia is simply absent there, which otherwise looks like a
      // LiveKit failure. See docs/04-runbook.md.
      this.micFailure = 'insecure_context';
      this.handlers.onMicState({ enabled: false, failure: this.micFailure });
      return;
    }
    try {
      await this.room.localParticipant.setMicrophoneEnabled(true);
      this.micFailure = null;
      this.handlers.onMicState({ enabled: true, failure: null });
    } catch (err) {
      this.micFailure = classifyMicError(err);
      this.handlers.onMicState({ enabled: false, failure: this.micFailure });
    }
  }

  private wireEvents(room: Room): void {
    room.on(RoomEvent.ConnectionStateChanged, (state) => {
      if (state === ConnectionState.Reconnecting || state === ConnectionState.SignalReconnecting) {
        this.wasReconnecting = true;
      } else if (state === ConnectionState.Connected) {
        this.wasReconnecting = false;
      }
      this.handlers.onConnectionState(state);
    });

    room.on(RoomEvent.TrackPublished, (pub, participant) => {
      this.applySubscription(pub, participant);
    });

    room.on(RoomEvent.TrackSubscribed, (track) => {
      this.attachAudio(track);
    });

    room.on(RoomEvent.TrackUnsubscribed, (track) => {
      for (const el of track.detach()) el.remove();
    });

    room.on(RoomEvent.ParticipantConnected, (participant) => {
      this.notifyPresence(participant, true);
      // A participant that publishes after we joined is covered by
      // TrackPublished; one that already had tracks is covered here.
      for (const pub of participant.trackPublications.values()) {
        this.applySubscription(pub, participant);
      }
    });

    room.on(RoomEvent.ParticipantDisconnected, (participant) => {
      this.notifyPresence(participant, false);
      if (participant.identity === this.join.peer.userId) {
        void this.teardown('peer_left');
      }
    });

    room.on(RoomEvent.AudioPlaybackStatusChanged, () => {
      this.handlers.onAudioBlocked(!room.canPlaybackAudio);
    });

    room.on(RoomEvent.ConnectionQualityChanged, (quality, participant) => {
      if (participant.identity === this.join.self.userId) {
        this.lastQuality = quality;
      }
    });

    room.on(RoomEvent.MediaDevicesError, (err) => {
      this.micFailure = classifyMicError(err);
      this.handlers.onMicState({ enabled: false, failure: this.micFailure });
    });

    room.on(RoomEvent.Disconnected, () => {
      if (this.hangingUp) {
        void this.teardown('local');
      } else {
        void this.teardown(this.wasReconnecting ? 'connection_lost' : 'server');
      }
    });
  }

  /**
   * The whole of mode routing lives here. DIRECT means the peer's raw
   * microphone and nothing else - there is no agent in the room at all, and
   * that is the healthy state, not a missing dependency. TRANSLATED/FORCED
   * means the one agent track addressed to me, and never the peer's raw mic.
   */
  private shouldSubscribe(pub: RemoteTrackPublication, participant: RemoteParticipant): boolean {
    if (pub.kind !== Track.Kind.Audio) return false;
    if (this.mode === 'DIRECT') {
      return (
        participant.identity === this.join.peer.userId && pub.source === Track.Source.Microphone
      );
    }
    const agentIdentity = this.join.agentIdentity ?? this.config.agentIdentity;
    const wanted = this.join.expectedAgentTrackName ?? `tx-${this.join.self.userId}`;
    return participant.identity === agentIdentity && pub.trackName === wanted;
  }

  private applySubscription(pub: RemoteTrackPublication, participant: RemoteParticipant): void {
    const want = this.shouldSubscribe(pub, participant);
    if (pub.isSubscribed === want) return;
    pub.setSubscribed(want);
  }

  private attachAudio(track: RemoteTrack): void {
    if (track.kind !== Track.Kind.Audio) return;
    const el = track.attach();
    // playsinline keeps iOS Safari from trying to take the audio fullscreen.
    el.setAttribute('playsinline', '');
    el.autoplay = true;
    this.audioSink.appendChild(el);
    const room = this.room;
    if (room && !room.canPlaybackAudio) this.handlers.onAudioBlocked(true);
  }

  private notifyPresence(participant: RemoteParticipant, present: boolean): void {
    if (participant.identity === this.join.peer.userId) {
      this.handlers.onPeerPresence(present);
    }
    const agentIdentity = this.join.agentIdentity ?? this.config.agentIdentity;
    if (participant.identity === agentIdentity) {
      this.handlers.onAgentPresence(present);
    }
  }

  private async readSubtitle(pending: Promise<string>): Promise<void> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await pending);
    } catch {
      return;
    }
    if (!isSubtitleMessage(parsed)) return;
    const now = Date.now();
    if (parsed.isFinal) {
      const first = this.segmentFirstSeen.get(parsed.segmentId);
      if (first !== undefined) {
        this.lastSegmentMs = now - first;
        this.segmentFirstSeen.delete(parsed.segmentId);
      }
    } else if (!this.segmentFirstSeen.has(parsed.segmentId)) {
      this.segmentFirstSeen.set(parsed.segmentId, now);
    }
    this.handlers.onSubtitle(parsed);
  }

  private async readState(pending: Promise<string>): Promise<void> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await pending);
    } catch {
      return;
    }
    if (!isStateMessage(parsed)) return;
    this.handlers.onAgentState(parsed);
  }

  private async sampleMetrics(): Promise<void> {
    const metrics: CallMetrics = {
      rttMs: null,
      jitterBufferMs: null,
      segmentMs: this.lastSegmentMs,
      quality: this.lastQuality,
    };

    const track = this.firstSubscribedAudioTrack();
    if (track) {
      try {
        const report = await track.getRTCStatsReport();
        if (report) Object.assign(metrics, readAudioStats(report));
        metrics.segmentMs = this.lastSegmentMs;
        metrics.quality = this.lastQuality;
      } catch {
        // Stats are advisory; a browser that refuses them must not break the call.
      }
    }

    this.handlers.onMetrics(metrics);
  }

  private firstSubscribedAudioTrack(): RemoteTrack | null {
    if (!this.room) return null;
    for (const participant of this.room.remoteParticipants.values()) {
      for (const pub of participant.trackPublications.values()) {
        if (pub.isSubscribed && pub.kind === Track.Kind.Audio && pub.track) {
          return pub.track as RemoteTrack;
        }
      }
    }
    return null;
  }

  private async teardown(
    reason: 'local' | 'peer_left' | 'connection_lost' | 'server',
    opts: { silent?: boolean } = {},
  ): Promise<void> {
    if (this.ended) return;
    this.ended = true;

    if (this.metricsTimer !== null) {
      window.clearInterval(this.metricsTimer);
      this.metricsTimer = null;
    }

    const room = this.room;
    this.room = null;
    if (room) {
      room.removeAllListeners();
      try {
        room.unregisterTextStreamHandler(this.config.subtitleTopic);
        room.unregisterTextStreamHandler(this.config.stateTopic);
      } catch {
        // Unregistering an already-torn-down handler is not an error worth surfacing.
      }
      try {
        await room.disconnect(true);
      } catch {
        // Already gone.
      }
    }

    this.audioSink.replaceChildren();
    if (!opts.silent) this.handlers.onEnded(reason);
  }
}

function readAudioStats(report: RTCStatsReport): Partial<CallMetrics> {
  const out: Partial<CallMetrics> = {};
  report.forEach((entry) => {
    const stat = entry as Record<string, unknown>;
    const type = stat['type'];
    if (type === 'candidate-pair') {
      const selected = stat['nominated'] === true || stat['state'] === 'succeeded';
      const rtt = stat['currentRoundTripTime'];
      if (selected && typeof rtt === 'number') out.rttMs = Math.round(rtt * 1000);
    } else if (type === 'remote-inbound-rtp' && out.rttMs === undefined) {
      const rtt = stat['roundTripTime'];
      if (typeof rtt === 'number') out.rttMs = Math.round(rtt * 1000);
    } else if (type === 'inbound-rtp' && stat['kind'] === 'audio') {
      const delay = stat['jitterBufferDelay'];
      const emitted = stat['jitterBufferEmittedCount'];
      if (typeof delay === 'number' && typeof emitted === 'number' && emitted > 0) {
        out.jitterBufferMs = Math.round((delay / emitted) * 1000);
      }
    }
  });
  return out;
}

function classifyMicError(err: unknown): MicFailureKind {
  const name = typeof err === 'object' && err !== null ? String((err as Error).name ?? '') : '';
  const message = err instanceof Error ? err.message : String(err);
  if (name === 'NotAllowedError' || /permission|denied/i.test(message)) return 'denied';
  if (name === 'NotFoundError' || /not\s*found|no.*device/i.test(message)) return 'not_found';
  if (/secure context|getUserMedia is not/i.test(message)) return 'insecure_context';
  return 'unknown';
}

export function micFailureText(kind: MicFailureKind): string {
  switch (kind) {
    case 'denied':
      return 'Microphone blocked. Allow it in the browser site settings, then reload.';
    case 'not_found':
      return 'No microphone found on this device.';
    case 'insecure_context':
      return 'This page is not a secure context, so the browser hides the microphone. Use http://localhost or serve the page over https.';
    case 'unknown':
      return 'Could not start the microphone.';
  }
}
