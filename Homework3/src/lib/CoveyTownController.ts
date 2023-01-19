import { customAlphabet, nanoid } from 'nanoid';
import { BoundingBox, ServerConversationArea } from '../client/TownsServiceClient';
import { UserLocation } from '../CoveyTypes';
import CoveyTownListener from '../types/CoveyTownListener';
import Player from '../types/Player';
import PlayerSession from '../types/PlayerSession';
import IVideoClient from './IVideoClient';
import TwilioVideo from './TwilioVideo';

const friendlyNanoID = customAlphabet('1234567890ABCDEF', 8);

/**
 * The CoveyTownController implements the logic for each town: managing the various events that
 * can occur (e.g. joining a town, moving, leaving a town)
 */
export default class CoveyTownController {
  get capacity(): number {
    return this._capacity;
  }

  set isPubliclyListed(value: boolean) {
    this._isPubliclyListed = value;
  }

  get isPubliclyListed(): boolean {
    return this._isPubliclyListed;
  }

  get townUpdatePassword(): string {
    return this._townUpdatePassword;
  }

  get players(): Player[] {
    return this._players;
  }

  get occupancy(): number {
    return this._listeners.length;
  }

  get friendlyName(): string {
    return this._friendlyName;
  }

  set friendlyName(value: string) {
    this._friendlyName = value;
  }

  get coveyTownID(): string {
    return this._coveyTownID;
  }

  get conversationAreas(): ServerConversationArea[] {
    return this._conversationAreas;
  }

  /** The list of players currently in the town * */
  private _players: Player[] = [];

  /** The list of valid sessions for this town * */
  private _sessions: PlayerSession[] = [];

  /** The videoClient that this CoveyTown will use to provision video resources * */
  private _videoClient: IVideoClient = TwilioVideo.getInstance();

  /** The list of CoveyTownListeners that are subscribed to events in this town * */
  private _listeners: CoveyTownListener[] = [];

  /** The list of currently active ConversationAreas in this town */
  private _conversationAreas: ServerConversationArea[] = [];

  private readonly _coveyTownID: string;

  private _friendlyName: string;

  private readonly _townUpdatePassword: string;

  private _isPubliclyListed: boolean;

  private _capacity: number;

  constructor(friendlyName: string, isPubliclyListed: boolean) {
    this._coveyTownID = process.env.DEMO_TOWN_ID === friendlyName ? friendlyName : friendlyNanoID();
    this._capacity = 50;
    this._townUpdatePassword = nanoid(24);
    this._isPubliclyListed = isPubliclyListed;
    this._friendlyName = friendlyName;
  }

  /**
   * Adds a player to this Covey Town, provisioning the necessary credentials for the
   * player, and returning them
   *
   * @param newPlayer The new player to add to the town
   */
  async addPlayer(newPlayer: Player): Promise<PlayerSession> {
    // Creates player session
    const theSession = new PlayerSession(newPlayer);
    
    // adds session to sessions list
    this._sessions.push(theSession);
    // adds player ID to players list
    this._players.push(newPlayer);

    // Create a video token for this user to join this town
    theSession.videoToken = await this._videoClient.getTokenForTown(
      this._coveyTownID,
      newPlayer.id,
    );

    // Notify other players that this player has joined
    this._listeners.forEach(listener => listener.onPlayerJoined(newPlayer));

    return theSession;
  }

  /**
   * Destroys all data related to a player in this town.
   *
   * @param session PlayerSession to destroy
   */
  destroySession(session: PlayerSession): void {
    // removes all players with given session id from players list
    this._players = this._players.filter(p => p.id !== session.player.id);
    // removes session with given session token from sessions list
    this._sessions = this._sessions.filter(s => s.sessionToken !== session.sessionToken);
    // notifies listeners that player session ended
    this._listeners.forEach(listener => listener.onPlayerDisconnected(session.player));

    // remove player from active conversation area
    const conversation = session.player.activeConversationArea;
    if (conversation) {
      this.removePlayerFromConversationArea(session.player, conversation);
    }
  }

  /**
   * Updates the location of a player within the town
   * 
   * If the player has changed conversation areas, this method also updates the
   * corresponding ConversationArea objects tracked by the town controller, and dispatches
   * any onConversationUpdated events as appropriate
   * 
   * @param player Player to update location for
   * @param location New location for this player
   */
  updatePlayerLocation(player: Player, location: UserLocation): void {
    // Find new conversation area from player location
    const conversation = this.conversationAreas.find(conv => conv.label === location.conversationLabel);
    // Find old conversation area from player state
    const prevConversation = player.activeConversationArea;

    // updates players location attribute with new location
    player.location = location;
    // Update player conversation area to match new location
    player.activeConversationArea = conversation;

    // If old and new conversation areas are different
    if (conversation !== prevConversation) {

      if (prevConversation) {
        // remove player from old conversation area
        this.removePlayerFromConversationArea(player, prevConversation);
      }
      if (conversation) {
        // add player to new conversation area occupants list
        conversation.occupantsByID.push(player.id);
        // notify listeners of conversation area update
        this._listeners.forEach(listener => listener.onConversationAreaUpdated(conversation));
      }
    }
    // notify listeners of player move update
    this._listeners.forEach(listener => listener.onPlayerMoved(player));
  }

  /**
   * Removes a player from a conversation area, updating the conversation area's occupants list, 
   * and emitting the appropriate message (area updated or area destroyed)
   * 
   * Does not update the player's activeConversationArea property.
   * 
   * @param player Player to remove from conversation area
   * @param conversation Conversation area to remove player from
   */
  removePlayerFromConversationArea(player: Player, conversation: ServerConversationArea) : void {
    // removes player with given ID from occupantsByID list
    conversation.occupantsByID.splice(conversation.occupantsByID.findIndex(p=>p === player.id), 1);
    // if conversation area is empty
    if (conversation.occupantsByID.length === 0) {
      // remove conversation area from conversation areas list 
      this._conversationAreas.splice(this._conversationAreas.findIndex(conv => conv === conversation), 1);
      // notify listeners conversation area destroyed
      this._listeners.forEach(listener => listener.onConversationAreaDestroyed(conversation));
      // console.log("destroyed test");
    } else {
      // notify listeners conversation area has been updated if it has occupants
      this._listeners.forEach(listener => listener.onConversationAreaUpdated(conversation));
    }
  }

  /**
   * Creates a new conversation area in this town if there is not currently an active
   * conversation with the same label.
   *
   * Adds any players who are in the region defined by the conversation area to it.
   *
   * Notifies any CoveyTownListeners that the conversation has been updated
   *
   * @param _conversationArea Information describing the conversation area to create. Ignores any
   *  occupantsById that are set on the conversation area that is passed to this method.
   *
   * @returns true if the conversation is successfully created, or false if not
   */
  addConversationArea(_conversationArea: ServerConversationArea): boolean {
    
    // Fail if conversation area with same label already exists in town
    if (this._conversationAreas.find(
      eachExistingConversation => eachExistingConversation.label === _conversationArea.label,
    )) {// console.log("label exists failed " + _conversationArea.label + " label" );
      return false; 
    }

    // Fail if conversation has no topic
    if (_conversationArea.topic === ''){
      // console.log("topic failed becuase field empty");
      return false;
    }

    // Fails if bounding box overlaps another conversation areas bounds
    if (this._conversationAreas.find(eachExistingConversation => 
      CoveyTownController.boxesOverlap(eachExistingConversation.boundingBox, _conversationArea.boundingBox)) !== undefined) {
      // console.log("BB failed: " + _conversationArea.boundingBox);
      return false;
    }

    // Create a new conversation area
    const newArea : ServerConversationArea = Object.assign(_conversationArea);
    // Add conversation area to conversation area list
    this._conversationAreas.push(newArea);
    // Get list of players within conversation area bounds
    const playersInThisConversation = this.players.filter(player => player.isWithin(newArea));
    // Add ID of each player in bounds to conversation areas occupants list
    playersInThisConversation.forEach(player => {player.activeConversationArea = newArea;});
    newArea.occupantsByID = playersInThisConversation.map(player => player.id);
    // Notify all listeners of conversation area update
    this._listeners.forEach(listener => listener.onConversationAreaUpdated(newArea));
    return true;
  }

  /**
   * Detects whether two bounding boxes overlap and share any points
   * 
   * @param box1 
   * @param box2 
   * @returns true if the boxes overlap, otherwise false
   */
  static boxesOverlap(box1: BoundingBox, box2: BoundingBox):boolean{
    // Helper function to extract the top left (x1,y1) and bottom right corner (x2,y2) of each bounding box
    const toRectPoints = (box: BoundingBox) => ({ x1: box.x - box.width / 2, x2: box.x + box.width / 2, y1: box.y - box.height / 2, y2: box.y + box.height / 2 });
    const rect1 = toRectPoints(box1);
    const rect2 = toRectPoints(box2);
    const noOverlap = rect1.x1 >= rect2.x2 || rect2.x1 >= rect1.x2 || rect1.y1 >= rect2.y2 || rect2.y1 >= rect1.y2;
    return !noOverlap;
  }

  /**
   * Subscribe to events from this town. Callers should make sure to
   * unsubscribe when they no longer want those events by calling removeTownListener
   *
   * @param listener New listener
   */
  addTownListener(listener: CoveyTownListener): void {
    this._listeners.push(listener);
  }

  /**
   * Unsubscribe from events in this town.
   *
   * @param listener The listener to unsubscribe, must be a listener that was registered
   * with addTownListener, or otherwise will be a no-op
   */
  removeTownListener(listener: CoveyTownListener): void {
    this._listeners = this._listeners.filter(v => v !== listener);
  }

  /**
   * Fetch a player's session based on the provided session token. Returns undefined if the
   * session token is not valid.
   *
   * @param token
   */
  getSessionByToken(token: string): PlayerSession | undefined {
    return this._sessions.find(p => p.sessionToken === token);
  }

  disconnectAllPlayers(): void {
    this._listeners.forEach(listener => listener.onTownDestroyed());
  }

}
