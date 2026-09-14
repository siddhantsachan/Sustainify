const mongoose = require('mongoose');
// Connection is managed centrally in app.js — not here

const pickupSchema=new mongoose.Schema({
    date:{
        type:Date,
        required:true
    },
    time:{
        type:String,
        required:true

    },
    address:{
        type:String,
        required:true
    },
    pincode:{
        type:Number,
        required:true
    },
    weight:{
        type:String,
        required:true
    },
    remarks:String,
    user:{
        type:mongoose.Schema.Types.ObjectId,
        ref:"UserAuth"
    },
    email:{
        type:String,
        required:true
    },
    status:{
        type:String,
        enum:['Pending','Completed','Cancelled'],
        default:'Pending'
    }
})

module.exports=mongoose.model("pickup",pickupSchema);