goog.provide('os.ui.ol.interaction.DrawPolygon');

goog.require('goog.events.BrowserEvent');
goog.require('goog.events.KeyHandler');
goog.require('ol');
goog.require('ol.MapBrowserEventType');
goog.require('ol.events.condition');
goog.require('ol.extent');
goog.require('ol.geom.LineString');
goog.require('ol.geom.Polygon');
goog.require('ol.layer.Vector');
goog.require('ol.source.Vector');
goog.require('os.data.RecordField');
goog.require('os.geo.jsts');
goog.require('os.geo2');
goog.require('os.ui.draw.DrawEvent');
goog.require('os.ui.ol.interaction.AbstractDraw');
goog.require('os.webgl');



/**
 * @constructor
 * @extends {os.ui.ol.interaction.AbstractDraw}
 */
os.ui.ol.interaction.DrawPolygon = function() {
  os.ui.ol.interaction.DrawPolygon.base(this, 'constructor', {
    handleEvent: os.ui.ol.interaction.DrawPolygon.handleEvent_,
    handleDownEvent: os.ui.ol.interaction.DrawPolygon.handleDownEvent_,
    handleMoveEvent: os.ui.ol.interaction.DrawPolygon.handleMoveEvent_,
    handleUpEvent: os.ui.ol.interaction.DrawPolygon.handleUpEvent_
  });
  this.type = os.ui.ol.interaction.DrawPolygon.TYPE;

  /**
   * @protected
   * @type {Array.<!ol.Coordinate>}
   */
  this.coords = [];

  /**
   * The coords removed with an undo in case they are needed for a redo.
   * @protected
   * @type {!Array.<!ol.Coordinate>}
   */
  this.backupcoords = [];

  /**
   * @protected
   * @type {ol.layer.Vector}
   */
  this.overlay2D = null;

  /**
   * @protected
   * @type {ol.Feature}
   */
  this.line2D = null;

  /**
   * @type {boolean}
   * @protected
   */
  this.finish = false;

  /**
   * @type {?ol.Pixel}
   * @private
   */
  this.downPixel_ = null;

  /**
   * @type {goog.events.KeyHandler}
   * @private
   */
  this.undoKeyHandler_ = null;
};
goog.inherits(os.ui.ol.interaction.DrawPolygon, os.ui.ol.interaction.AbstractDraw);


/**
 * @type {string}
 * @const
 */
os.ui.ol.interaction.DrawPolygon.TYPE = 'polygon';


/**
 * @inheritDoc
 */
os.ui.ol.interaction.DrawPolygon.prototype.disposeInternal = function() {
  this.cleanup();

  os.ui.ol.interaction.DrawPolygon.base(this, 'disposeInternal');
};


/**
 * @inheritDoc
 */
os.ui.ol.interaction.DrawPolygon.prototype.getGeometry = function() {
  var geom = new ol.geom.Polygon([this.coords]);
  var method = os.interpolate.getMethod();
  geom.set(os.interpolate.METHOD_FIELD, method);
  geom.toLonLat();

  // normalize coordinates prior to validation, or polygons crossing the date line may be broken
  var normalizationPoint = os.geo2.computeWindingOrder(geom.getCoordinates()[0]) ? 0 : undefined;
  os.geo2.normalizeGeometryCoordinates(geom, normalizationPoint, os.proj.EPSG4326);

  // then interpolate so the coordinates reflect what was drawn
  os.interpolate.beginTempInterpolation(os.proj.EPSG4326, method);
  os.interpolate.interpolateGeom(geom);
  os.interpolate.endTempInterpolation();

  // finally validate the geometry to ensure it's accepted in server queries
  geom = os.geo.jsts.validate(geom);

  geom.osTransform();
  return geom;
};


/**
 * @inheritDoc
 */
os.ui.ol.interaction.DrawPolygon.prototype.getProperties = function() {
  var props = {};
  props[os.interpolate.METHOD_FIELD] = os.interpolate.getMethod();
  props[os.data.RecordField.ALTITUDE_MODE] = os.webgl.AltitudeMode.CLAMP_TO_GROUND;
  return props;
};


/**
 * @param {ol.MapBrowserPointerEvent} mapBrowserEvent Event.
 * @this os.ui.ol.interaction.DrawPolygon
 * @private
 */
os.ui.ol.interaction.DrawPolygon.handleMoveEvent_ = function(mapBrowserEvent) {
  if (this.drawing) {
    this.update(mapBrowserEvent);
  }
};


/**
 * @param {ol.MapBrowserEvent} mapBrowserEvent Event.
 * @this os.ui.ol.interaction.DrawPolygon
 * @return {boolean}
 * @private
 * @suppress {accessControls}
 */
os.ui.ol.interaction.DrawPolygon.handleEvent_ = function(mapBrowserEvent) {
  if (!(mapBrowserEvent instanceof ol.MapBrowserPointerEvent)) {
    return true;
  }

  this.updateTrackedPointers_(mapBrowserEvent);

  if (mapBrowserEvent.type == ol.MapBrowserEventType.POINTERUP) {
    this.handleUpEvent_(mapBrowserEvent);
  } else if (mapBrowserEvent.type == ol.MapBrowserEventType.POINTERDOWN) {
    this.handleDownEvent_(mapBrowserEvent);
  } else if (mapBrowserEvent.type == ol.MapBrowserEventType.POINTERMOVE) {
    this.handleMoveEvent_(mapBrowserEvent);
  }

  return true;
};


/**
 * @param {ol.MapBrowserPointerEvent} mapBrowserEvent Event.
 * @this os.ui.ol.interaction.DrawPolygon
 * @return {boolean}
 * @private
 */
os.ui.ol.interaction.DrawPolygon.handleUpEvent_ = function(mapBrowserEvent) {
  var px = mapBrowserEvent.pixel;

  if (this.downPixel_ && Math.abs(px[0] - this.downPixel_[0]) < 3 && Math.abs(px[1] - this.downPixel_[1]) < 3) {
    this.downPixel_ = null;
    if (!this.drawing) {
      this.begin(mapBrowserEvent);
    }

    if (this.shouldFinish(mapBrowserEvent)) {
      this.saveLast(mapBrowserEvent);
      this.end(mapBrowserEvent);
    } else {
      this.update(mapBrowserEvent);
    }
  }

  return false;
};


/**
 * @param {ol.MapBrowserPointerEvent} mapBrowserEvent Event.
 * @this os.ui.ol.interaction.DrawPolygon
 * @return {boolean}
 * @private
 */
os.ui.ol.interaction.DrawPolygon.handleDownEvent_ = function(mapBrowserEvent) {
  // In order to allow dragging while this interaction is enabled, we're just
  // gonna store the mouse down pixel for now and check it again on the up
  // event. If it is close enough, we'll call it a click and not a click+drag.
  var browserEvent = new goog.events.BrowserEvent(mapBrowserEvent.originalEvent);
  if (browserEvent.isMouseActionButton() && (this.drawing || this.condition(mapBrowserEvent))) {
    this.downPixel_ = mapBrowserEvent.pixel;
  }

  return false;
};


/**
 * @param {ol.MapBrowserPointerEvent} mapBrowserEvent Event.
 * @protected
 */
os.ui.ol.interaction.DrawPolygon.prototype.saveLast = function(mapBrowserEvent) {
  this.coords[this.coords.length - 1] = this.coords[0];
};


/**
 * @param {ol.MapBrowserPointerEvent} mapBrowserEvent Event.
 * @return {boolean} Whether or not we should finish drawing
 * @protected
 */
os.ui.ol.interaction.DrawPolygon.prototype.shouldFinish = function(mapBrowserEvent) {
  if (this.coords.length > 3) {
    var start = this.getMap().getPixelFromCoordinate(this.coords[0]);
    var px = mapBrowserEvent.pixel;

    if (start && px) {
      return Math.abs(px[0] - start[0]) < 7 && Math.abs(px[1] - start[1]) < 7;
    }
  }

  return false;
};


/**
 * @inheritDoc
 */
os.ui.ol.interaction.DrawPolygon.prototype.begin = function(mapBrowserEvent) {
  this.finish = false;
  os.ui.ol.interaction.DrawPolygon.base(this, 'begin', mapBrowserEvent);
  os.interpolate.updateTransforms();
  this.coords.length = 0;
  this.backupcoords.length = 0;
  this.undoKeyHandler_ = new goog.events.KeyHandler(goog.dom.getDocument(), true);
  this.undoKeyHandler_.listen(goog.events.KeyHandler.EventType.KEY, this.handleKeyEvent_, true, this);
};


/**
 * @inheritDoc
 */
os.ui.ol.interaction.DrawPolygon.prototype.update = function(mapBrowserEvent) {
  this.addCoord(mapBrowserEvent.coordinate, mapBrowserEvent);
};


/**
 * @param {ol.Coordinate} coord
 * @param {ol.MapBrowserEvent=} opt_mapBrowserEvent
 * @protected
 */
os.ui.ol.interaction.DrawPolygon.prototype.addCoord = function(coord, opt_mapBrowserEvent) {
  if (coord) {
    if (opt_mapBrowserEvent) {
      if (opt_mapBrowserEvent.type === ol.MapBrowserEventType.POINTERUP) {
        this.backupcoords.length = 0;
        this.coords.push(coord);

        if (this.coords.length == 1) {
          this.coords.push(coord);
        }
      } else if (this.coords.length > 1) {
        this.coords[this.coords.length - 1] = coord;
      }
    } else {
      this.coords.push(coord);
    }

    this.beforeUpdate(opt_mapBrowserEvent);

    if (this.coords.length > 1) {
      this.update2D();
    }
  }
};


/**
 * This is for extending classes
 *
 * @param {ol.MapBrowserEvent=} opt_mapBrowserEvent
 * @protected
 */
os.ui.ol.interaction.DrawPolygon.prototype.beforeUpdate = function(opt_mapBrowserEvent) {
};


/**
 * Updates the 2D version
 *
 * @protected
 */
os.ui.ol.interaction.DrawPolygon.prototype.update2D = function() {
  this.createOverlay();
  this.overlay2D.setMap(this.getMap());

  if (!this.line2D) {
    this.line2D = new ol.Feature();
    this.line2D.setStyle(this.getStyle());
    this.line2D.set(os.interpolate.METHOD_FIELD, os.interpolate.getMethod());
    this.overlay2D.getSource().addFeature(this.line2D);
  }

  var geom = this.createGeometry();
  os.geo2.normalizeGeometryCoordinates(geom, 0, os.proj.EPSG4326);

  this.line2D.setGeometry(geom);
  this.line2D.set(os.interpolate.ORIGINAL_GEOM_FIELD, undefined);
  this.line2D.setProperties(this.getProperties(), true);
  os.interpolate.interpolateFeature(this.line2D);
};


/**
 * Creates the 2D overlay if it doesn't exist already.
 */
os.ui.ol.interaction.DrawPolygon.prototype.createOverlay = function() {
  if (!this.overlay2D) {
    this.overlay2D = new ol.layer.Vector({
      map: this.getMap(),
      source: new ol.source.Vector({
        features: new ol.Collection(),
        useSpatialIndex: false
      }),
      style: this.getStyle(),
      updateWhileAnimating: true,
      updateWhileInteracting: true
    });
  }
};


/**
 * @protected
 * @return {ol.geom.Geometry}
 */
os.ui.ol.interaction.DrawPolygon.prototype.createGeometry = function() {
  return new ol.geom.LineString(this.coords.slice());
};


/**
 * Handle keyboard events.
 *
 * @param {goog.events.KeyEvent} event
 * @private
 */
os.ui.ol.interaction.DrawPolygon.prototype.handleKeyEvent_ = function(event) {
  var ctrlOr = os.isOSX() ? event.metaKey : event.ctrlKey;

  if (!document.querySelector(os.ui.MODAL_SELECTOR)) {
    switch (event.keyCode) {
      case goog.events.KeyCodes.Z:
        if (ctrlOr) {
          event.stopPropagation();
          event.preventDefault();
          // macs default to cmd+shift+z for undo
          event.shiftKey ? this.redo_() : this.undo_();
        }
        break;
      case goog.events.KeyCodes.Y:
        if (ctrlOr) {
          event.stopPropagation();
          event.preventDefault();
          this.redo_();
        }
        break;
      default:
        break;
    }
  }
};


/**
 * Undo the last point from the shape.
 * @private
 */
os.ui.ol.interaction.DrawPolygon.prototype.undo_ = function() {
  if (this.coords.length > 2) {
    // pop off the temp coord (where mouse pointer is)
    var mousePosition = this.coords.pop();
    // pop off the actual coord we want to remove
    this.backupcoords.push(this.coords.pop());
    this.addCoord(mousePosition);
  } else {
    this.coords.length = 0;
    this.cancel();
  }
};

/**
 * Restore the last point removed from the shape.
 * @private
 */
os.ui.ol.interaction.DrawPolygon.prototype.redo_ = function() {
  // pop off the temp coord (where mouse pointer is)
  var mousePosition = this.coords.pop();
  this.addCoord(this.backupcoords.pop());
  this.addCoord(mousePosition);
};


/**
 * @inheritDoc
 */
os.ui.ol.interaction.DrawPolygon.prototype.cleanup = function() {
  os.ui.ol.interaction.DrawPolygon.base(this, 'cleanup');

  if (this.overlay2D) {
    this.overlay2D.getSource().getFeaturesCollection().clear();
    this.overlay2D.setMap(null);
    this.overlay2D.dispose();
    this.overlay2D = null;
  }

  if (this.line2D) {
    this.line2D = null;
  }

  goog.dispose(this.undoKeyHandler_);
};


/**
 * @inheritDoc
 */
os.ui.ol.interaction.DrawPolygon.prototype.getResultString = function() {
  return this.coords.toString();
};
