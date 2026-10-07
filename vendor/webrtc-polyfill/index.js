// No WebRTC on the server: simple-peer then reports WEBRTC_SUPPORT = false and
// bittorrent-tracker skips ws:// / wss:// (browser-only) trackers.
export const RTCPeerConnection = null
export const RTCSessionDescription = null
export const RTCIceCandidate = null
export default {}
