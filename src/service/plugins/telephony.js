"use strict";

// Imports
const Lang = imports.lang;
const Gettext = imports.gettext.domain("org.gnome.shell.extensions.gsconnect");
const _ = Gettext.gettext;

const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;
const Gtk = imports.gi.Gtk;
const Notify = imports.gi.Notify;

// Local Imports
function getPath() {
    // Diced from: https://github.com/optimisme/gjs-examples/
    let m = new RegExp("@(.+):\\d+").exec((new Error()).stack.split("\n")[1]);
    let p = Gio.File.new_for_path(m[1]).get_parent().get_parent().get_parent();
    return p.get_path();
}

imports.searchPath.push(getPath());

const Common = imports.common;
const Protocol = imports.service.protocol;
const PluginsBase = imports.service.plugins.base;
const SMS = imports.service.plugins.sms;


var METADATA = {
    name: "telephony",
    incomingPackets: ["kdeconnect.telephony"],
    outgoingPackets: ["kdeconnect.telephony.request", "kdeconnect.sms.request"],
    settings: {}
};


/**
 * Telephony Plugin
 * https://github.com/KDE/kdeconnect-kde/tree/master/plugins/telephony
 */
var Plugin = new Lang.Class({
    Name: "GSConnectTelephonyPlugin",
    Extends: PluginsBase.Plugin,
    Signals: {
        "missedCall": {
            flags: GObject.SignalFlags.RUN_FIRST | GObject.SignalFlags.DETAILED,
            // phoneNumber, contactName
            param_types: [GObject.TYPE_STRING, GObject.TYPE_STRING]
        },
        "ringing": {
            flags: GObject.SignalFlags.RUN_FIRST | GObject.SignalFlags.DETAILED,
            // phoneNumber, contactName
            param_types: [GObject.TYPE_STRING, GObject.TYPE_STRING]
        },
        "sms": {
            flags: GObject.SignalFlags.RUN_FIRST | GObject.SignalFlags.DETAILED,
            param_types: [
                GObject.TYPE_STRING,    // phoneNumber
                GObject.TYPE_STRING,    // contactName
                GObject.TYPE_STRING,    // messageBody
                GObject.TYPE_STRING     // phoneThumbnail
            ]
        },
        "talking": {
            flags: GObject.SignalFlags.RUN_FIRST | GObject.SignalFlags.DETAILED,
            // phoneNumber, contactName
            param_types: [GObject.TYPE_STRING, GObject.TYPE_STRING]
        }
    },
    
    _init: function (device) {
        this.parent(device, "telephony");
        
        Gtk.IconTheme.get_default().add_resource_path("/icons");
    },
    
    // TODO: try and block incoming sms "notifications"
    //       music pause, etc
    //       
    handlePacket: function (packet) {
        // There are six possible variables:
        //    * "event"             missedCall, ringing, sms or talking
        //    * "phoneNumber"       Always present?
        //    * "contactName"       Always present? (may be empty)
        //    * "messageBody"       SMS only?
        //    * "phoneThumbnail"    base64 ByteArray/Pixmap (may be empty)
        //    * "isCancel"          If true the packet should be ignored
        
        let sender;
        
         // FIXME: not sure what to do here...
//        if (!packet.body.phoneNumber.length) {
//            packet.body.phoneNumber = _("Unknown Number");
//        }
//        
//        if (packet.body.contactName === "") {
//            packet.body.contactName = _("Unknown Contact");
//        }
                
        if (packet.body.contactName.length) {
            sender = packet.body.contactName;
        } else {
            sender = packet.body.phoneNumber;
        }
        
        // Event handling
        if (packet.body.hasOwnProperty("isCancel") && packet.body.isCancel) {
            return;
        } else if (packet.body.event === "missedCall") {
            this.handleMissedCall(sender, packet);
        } else if (packet.body.event === "ringing") {
            this.handleRinging(sender, packet);
        } else if (packet.body.event === "sms") {
            this.handleSMS(sender, packet);
        } else if (packet.body.event === "talking") {
            this.handleTalking(sender, packet);
        } else {
            log("Unknown telephony event: " + packet.body.event);
        }
    },
    
    handleMissedCall: function (sender, packet) {
        this._dbus.emit_signal("missedCall",
            new GLib.Variant(
                "(ss)",
                [packet.body.phoneNumber,
                packet.body.contactName]
            )
        );
        
        if (this.settings.notify_missedCall) {
            let note = new Notify.Notification({
                app_name: "GSConnect",
                id: Number(packet.id.toString().slice(2)),
                summary: _("%s - Missed Call").format(this.device.name),
                body: _("Missed call from %s").format(sender),
                icon_name: "call-missed-symbolic"
            });
            
            note.show();
        }
    },
    
    handleRinging: function (sender, packet) {
        // TODO: music pause, etc
        this._dbus.emit_signal("ringing",
            new GLib.Variant(
                "(ss)",
                [packet.body.phoneNumber,
                packet.body.contactName]
            )
        );
        
        if (this.settings.notify_ringing) {
            let note = new Notify.Notification({
                app_name: "GSConnect",
                id: Number(packet.id.toString().slice(2)),
                summary: _("%s Ringing").format(this.device.name),
                body: _("Incoming call from %s").format(sender),
                icon_name: "call-start-symbolic"
            });
            
            note.add_action(
                "notify_sms",
                _("Mute"),
                Lang.bind(this, this.mute)
            );
            
            note.show();
        }
    },
    
    handleSMS: function (sender, packet) {
        // TODO: not really complete
        this._dbus.emit_signal("sms",
            new GLib.Variant(
                "(ssss)",
                [packet.body.phoneNumber,
                packet.body.contactName,
                packet.body.messageBody,
                packet.body.phoneThumbnail] // FIXME: bytearray.pixmap
            )
        );
        
        this.emit(
            "sms",
            packet.body.phoneNumber,
            packet.body.contactName,
            packet.body.messageBody,
            packet.body.phoneThumbnail
        );
        
        // FIXME: urgency
        //        block matching notification somehow?
        if (this.settings.autoreply_sms) {
            this.replySms(null, "autoreply_sms", packet.body);
        } else if (this.settings.notify_sms) {
            let note = new Notify.Notification({
                app_name: "GSConnect",
                id: Number(packet.id.toString().slice(2)),
                summary: sender,
                body: packet.body.messageBody,
                icon_name: "phone-symbolic"
            });
            
            note.add_action(
                "notify_sms", // action char
                _("Reply"), // label
                Lang.bind(this, this.replySms, packet.body)
            );
            
            note.show();
        }
    },
    
    handleTalking: function (sender, packet) {
        // TODO: music pause, etc
        this._dbus.emit_signal("talking",
            new GLib.Variant(
                "(ss)",
                [packet.body.phoneNumber,
                packet.body.contactName]
            )
        );
        
        if (this.settings.notify_talking) {
            note = new Notify.Notification({
                app_name: "GSConnect",
                id: Number(packet.id.toString().slice(2)),
                summary: _("%s - Talking").format(this.device.name),
                body: _("Call in progress with %s").format(sender),
                icon_name: "call-start-symbolic"
            });
            
            note.show();
        }
    },
    
    // TODO: test
    muteCall: function () {
        let packet = new Protocol.Packet();
        packet.type = "kdeconnect.telephony.request"
        packet.body = { action: "mute" };
        this.device._channel.send(packet);
    },
    
    openSms: function () {
        let win = new SMS.ApplicationWindow(this.device.daemon, this.device);
        win.present();
    },
    
    replySms: function (notification, action, args) {
        // Get the current open windows
        let windows = this.device.daemon.get_windows();
        let window = false;
        
        // Look for an open window that will already be catching messages
        for (let index_ in windows) {
            for (let number of windows[index_]._get_numbers()) {
                if (number === args.phoneNumber) {
                    window = windows[index_];
                    break;
                }
            }
            
            if (window !== false) { break; }
        }
        
        // None found, open a new one, add the contact and log the message
        if (!window) {
            window = new SMS.ApplicationWindow(this.device.daemon, this.device);
            
            if (args.contactName.length) {
                window.contactEntry.text = args.contactName + " <" + args.phoneNumber + ">; ";
                window._log_message(args.contactName, args.messageBody);
            } else {
                window.contactEntry.text = args.phoneNumber + "; ";
                window._log_message(args.phoneNumber, args.messageBody);
            }
        }
        
        // Present the window and bail
        window.present();
    },
    
    sendSms: function (phoneNumber, messageBody) {
        let packet = new Protocol.Packet({
            id: Date.now(),
            type: "kdeconnect.sms.request",
            body: {
                sendSms: true,
                phoneNumber: phoneNumber,
                messageBody: messageBody
            }
        });
        
        this.device._channel.send(packet);
    }
});

