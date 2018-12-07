/*
 * (C) Copyright 2017-2018 OpenVidu (https://openvidu.io/)
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 *
 */

import freeice = require('freeice');
import uuid = require('uuid');
import platform = require('platform');
import Webrtc = require('react-native-webrtc');

const {   RTCPeerConnection,
    RTCIceCandidate,
    RTCSessionDescription,
    RTCView,
    MediaStream,
    MediaStreamTrack,
    getUserMedia, } = Webrtc;
export interface WebRtcPeerConfiguration {
    mediaConstraints: {
        audio: boolean,
        video: boolean
    };
    simulcast: boolean;
    onicecandidate: (event) => void;
    iceServers: RTCIceServer[] | undefined;
    mediaStream?: MediaStream;
    mode?: string; // sendonly, reconly, sendrecv
    id?: string;
}

export class WebRtcPeer {

    pc: RTCPeerConnection;
    id: string;
    remoteCandidatesQueue: RTCIceCandidate[] = [];
    localCandidatesQueue: RTCIceCandidate[] = [];

    iceCandidateList: RTCIceCandidate[] = [];

    private candidategatheringdone = false;

    constructor(private configuration: WebRtcPeerConfiguration) {
        this.configuration.iceServers = (!!this.configuration.iceServers && this.configuration.iceServers.length > 0) ? this.configuration.iceServers : freeice();

        this.pc = new RTCPeerConnection({ iceServers: this.configuration.iceServers });
        this.id = !!configuration.id ? configuration.id : uuid.v4();

        this.pc.onicecandidate = event => {
            if (!!event.candidate) {
                const candidate: RTCIceCandidate = event.candidate;
                if (candidate) {
                    this.localCandidatesQueue.push(<RTCIceCandidate>{ candidate: candidate.candidate });
                    this.candidategatheringdone = false;
                    this.configuration.onicecandidate(event.candidate);
                } else if (!this.candidategatheringdone) {
                    this.candidategatheringdone = true;
                }
            }
        };

        this.pc.onsignalingstatechange = () => {
            if (this.pc.signalingState === 'stable') {
                while (this.iceCandidateList.length > 0) {
                    this.pc.addIceCandidate(<RTCIceCandidate>this.iceCandidateList.shift());
                }
            }
        };

        this.start();
    }

    /**
     * This function creates the RTCPeerConnection object taking into account the
     * properties received in the constructor. It starts the SDP negotiation
     * process: generates the SDP offer and invokes the onsdpoffer callback. This
     * callback is expected to send the SDP offer, in order to obtain an SDP
     * answer from another peer.
     */
    start(): Promise<any> {
        return new Promise((resolve, reject) => {
            if (this.pc.signalingState === 'closed') {
                reject('The peer connection object is in "closed" state. This is most likely due to an invocation of the dispose method before accepting in the dialogue');
            }
            if (!!this.configuration.mediaStream) {
                for (const track of this.configuration.mediaStream.getTracks()) {
                    this.pc.addTrack(track, this.configuration.mediaStream);
                }
                resolve();
            }
        });
    }

    /**
     * This method frees the resources used by WebRtcPeer
     */
    dispose(videoSourceIsMediaStreamTrack: boolean) {
        console.debug('Disposing WebRtcPeer');
        try {
            if (this.pc) {
                if (this.pc.signalingState === 'closed') {
                    return;
                }
                this.remoteCandidatesQueue = [];
                this.localCandidatesQueue = [];

                // Stop senders
                for (const sender of this.pc.getSenders()) {
                    if (!videoSourceIsMediaStreamTrack) {
                        if (!!sender.track) {
                            sender.track.stop();
                        }
                    }
                    this.pc.removeTrack(sender);
                }
                // Stop receivers
                for (const receiver of this.pc.getReceivers()) {
                    if (!!receiver.track) {
                        receiver.track.stop();
                    }
                }

                this.pc.close();
            }
        } catch (err) {
            console.warn('Exception disposing webrtc peer ' + err);
        }
    }

    /**
     * 1) Function that creates an offer, sets it as local description and returns the offer param
     * to send to OpenVidu Server (will be the remote description of other peer)
     */
    generateOffer(): Promise<string> {
        return new Promise((resolve, reject) => {
            let offerAudio, offerVideo = true;

            // Constraints must have both blocks
            if (!!this.configuration.mediaConstraints) {
                offerAudio = (typeof this.configuration.mediaConstraints.audio === 'boolean') ?
                    this.configuration.mediaConstraints.audio : true;
                offerVideo = (typeof this.configuration.mediaConstraints.video === 'boolean') ?
                    this.configuration.mediaConstraints.video : true;
            }

            const constraints: RTCOfferOptions = {
                offerToReceiveAudio: (this.configuration.mode !== 'sendonly' && offerAudio),
                offerToReceiveVideo: (this.configuration.mode !== 'sendonly' && offerVideo)
            };

            console.debug('RTCPeerConnection constraints: ' + JSON.stringify(constraints));

            this.pc.createOffer(constraints).then(offer => {
                console.debug('Created SDP offer');
                return this.pc.setLocalDescription(offer);
            }).then(() => {
                const localDescription = this.pc.localDescription;
                if (!!localDescription) {
                    console.debug('Local description set', localDescription.sdp);
                    resolve(<string>localDescription.sdp);
                } else {
                    reject('Local description is not defined');
                }
            }).catch(error => reject(error));
        });
    }

    /**
     * 2) Function to invoke when a SDP offer is received. Sets it as remote description,
     * generates and answer and returns it to send it to OpenVidu Server
     */
    processOffer(sdpOffer: string): Promise<ConstrainDOMString> {
        return new Promise((resolve, reject) => {
            const offer: RTCSessionDescriptionInit = {
                type: 'offer',
                sdp: sdpOffer
            };

            console.debug('SDP offer received, setting remote description');

            if (this.pc.signalingState === 'closed') {
                reject('PeerConnection is closed');
            }

            this.pc.setRemoteDescription(offer)
                .then(() => {
                    return this.pc.createAnswer();
                }).then(answer => {
                    console.debug('Created SDP answer');
                    return this.pc.setLocalDescription(answer);
                }).then(() => {
                    const localDescription = this.pc.localDescription;
                    if (!!localDescription) {
                        console.debug('Local description set', localDescription.sdp);
                        resolve(<string>localDescription.sdp);
                    } else {
                        reject('Local description is not defined');
                    }
                }).catch(error => reject(error));
        });
    }

    /**
     * 3) Function invoked when a SDP answer is received. Final step in SDP negotiation, the peer
     * just needs to set the answer as its remote description
     */
    processAnswer(sdpAnswer: string): Promise<string> {
        return new Promise((resolve, reject) => {

            const answer: RTCSessionDescriptionInit = {
                type: 'answer',
                sdp: sdpAnswer
            };

            console.debug('SDP answer received, setting remote description');

            if (this.pc.signalingState === 'closed') {
                reject('RTCPeerConnection is closed');
            }

            this.pc.setRemoteDescription(answer).then(() => resolve()).catch(error => reject(error));
        });
    }

    /**
     * Callback function invoked when an ICE candidate is received
     */
    addIceCandidate(iceCandidate: RTCIceCandidate): Promise<void> {
        return new Promise((resolve, reject) => {
            console.debug('Remote ICE candidate received', iceCandidate);
            this.remoteCandidatesQueue.push(iceCandidate);
            switch (this.pc.signalingState) {
                case 'closed':
                    reject(new Error('PeerConnection object is closed'));
                    break;
                case 'stable':
                    if (!!this.pc.remoteDescription) {
                        this.pc.addIceCandidate(iceCandidate).then(() => resolve()).catch(error => reject(error));
                    }
                    break;
                default:
                    this.iceCandidateList.push(iceCandidate);
                    resolve();
            }
        });
    }

}


export class WebRtcPeerRecvonly extends WebRtcPeer {
    constructor(configuration: WebRtcPeerConfiguration) {
        configuration.mode = 'recvonly';
        super(configuration);
    }
}

export class WebRtcPeerSendonly extends WebRtcPeer {
    constructor(configuration: WebRtcPeerConfiguration) {
        configuration.mode = 'sendonly';
        super(configuration);
    }
}

export class WebRtcPeerSendrecv extends WebRtcPeer {
    constructor(configuration: WebRtcPeerConfiguration) {
        configuration.mode = 'sendrecv';
        super(configuration);
    }
}