import type { Lead, LeadUpdate, Product, Quotation, User, Visit } from "@/lib/domain";

/** Sample data used only when DATA_SOURCE=mock (demo, tests, UI review without Zoho). */
export const MOCK_USERS: User[] = [
  {
    "id": "pavan",
    "name": "Pavan",
    "role": "Manager",
    "email": "pavan@example.com"
  },
  {
    "id": "saikiran",
    "name": "Sai Kiran",
    "role": "Manager",
    "email": "saikiran@example.com"
  },
  {
    "id": "anil",
    "name": "Anil",
    "role": "Sales Executive",
    "email": "anil@example.com"
  },
  {
    "id": "ravi",
    "name": "Ravi",
    "role": "Sales Executive",
    "email": "ravi@example.com"
  },
  {
    "id": "divya",
    "name": "Divya",
    "role": "Calling Team",
    "email": "divya@example.com"
  }
];

export const MOCK_PRODUCTS: Product[] = [
  {
    "id": "P1",
    "model": "1.5 TR Split AC",
    "price": 37000,
    "unit": "Nos"
  },
  {
    "id": "P2",
    "model": "2 TR Split AC",
    "price": 57000,
    "unit": "Nos"
  },
  {
    "id": "P3",
    "model": "3 TR 4-Way Cassette AC",
    "price": 122000,
    "unit": "Nos"
  },
  {
    "id": "P4",
    "model": "B - Installation Cassette AC",
    "price": 3000,
    "unit": "Nos"
  },
  {
    "id": "P5",
    "model": "B - Installation Split AC",
    "price": 1000,
    "unit": "Nos"
  },
  {
    "id": "P6",
    "model": "B - Copper piping (per Rmt)",
    "price": 1500,
    "unit": "Rmt"
  },
  {
    "id": "P7",
    "model": "B - Cable 4C x 2.5 sqmm with PVC conduit",
    "price": 100,
    "unit": "Rmt"
  },
  {
    "id": "P8",
    "model": "B - Drain piping 25mm",
    "price": 190,
    "unit": "Rmt"
  },
  {
    "id": "P9",
    "model": "B - Outdoor stand (cassette)",
    "price": 1200,
    "unit": "Nos"
  },
  {
    "id": "P10",
    "model": "B - Outdoor stand (split)",
    "price": 800,
    "unit": "Nos"
  }
];

export const MOCK_LEADS: Lead[] = [
  {
    "id": "L101",
    "name": "Srinivas Rao",
    "company": "Sri Lakshmi Textiles",
    "phone": "98480 12345",
    "area": "Ameerpet",
    "source": "Meta Ads",
    "status": "Quotation Sent",
    "assignedTo": "Anil",
    "remarks": "Needs 6 split ACs for showroom",
    "createdOn": "2026-10-02",
    "address": "6-3-249, Ameerpet Main Rd",
    "touchedBy": [
      "Divya"
    ]
  },
  {
    "id": "L102",
    "name": "Dr. Ramesh",
    "company": "Ramesh Clinic",
    "phone": "99891 22334",
    "area": "Kukatpally",
    "source": "Google Ads",
    "status": "Site Visit Scheduled",
    "assignedTo": "Ravi",
    "remarks": "Cassette AC for waiting hall",
    "createdOn": "2026-10-05",
    "address": "Plot 45, KPHB Phase 3",
    "touchedBy": [
      "Divya"
    ]
  },
  {
    "id": "L103",
    "name": "Mahesh Goud",
    "company": "Hotel Paradise Inn",
    "phone": "90000 45678",
    "area": "Secunderabad",
    "source": "Direct Call",
    "status": "Won",
    "assignedTo": "Anil",
    "remarks": "Ductable AC, 3 floors",
    "createdOn": "2026-09-21",
    "address": "SD Road, near Paradise Circle",
    "touchedBy": [
      "Divya"
    ]
  },
  {
    "id": "L104",
    "name": "Sunitha Reddy",
    "company": "",
    "phone": "97010 99887",
    "area": "Gachibowli",
    "source": "Meta Ads",
    "status": "Contacted",
    "assignedTo": "Ravi",
    "remarks": "2 inverter ACs for home",
    "createdOn": "2026-10-12",
    "address": "Flat 302, My Home Avatar",
    "touchedBy": [
      "Divya"
    ]
  },
  {
    "id": "L105",
    "name": "Arjun Varma",
    "company": "Cyber Towers Office 4B",
    "phone": "88860 11223",
    "area": "HITEC City",
    "source": "Google Ads",
    "status": "Fresh Lead",
    "assignedTo": null,
    "remarks": "VRF system enquiry",
    "createdOn": "2026-10-25",
    "address": "",
    "touchedBy": [
      "Divya"
    ]
  },
  {
    "id": "L106",
    "name": "Venkatesh",
    "company": "Balaji Sweets",
    "phone": "93470 55667",
    "area": "Dilsukhnagar",
    "source": "Direct Call",
    "status": "Fresh Lead",
    "assignedTo": null,
    "remarks": "AMC + 2 new units",
    "createdOn": "2026-10-26",
    "address": "",
    "touchedBy": [
      "Divya"
    ]
  },
  {
    "id": "L107",
    "name": "Principal Rao",
    "company": "Green Valley School",
    "phone": "96660 77889",
    "area": "Miyapur",
    "source": "Google Ads",
    "status": "Lost",
    "assignedTo": "Anil",
    "remarks": "12 classroom ACs, went with competitor",
    "createdOn": "2026-09-15",
    "address": "",
    "touchedBy": [
      "Divya"
    ]
  },
  {
    "id": "L108",
    "name": "Kiran Kumar",
    "company": "Kiran Motors",
    "phone": "91000 33445",
    "area": "Uppal",
    "source": "Meta Ads",
    "status": "Quotation Sent",
    "assignedTo": "Ravi",
    "remarks": "Showroom 5 TR",
    "createdOn": "2026-10-08",
    "address": "",
    "touchedBy": [
      "Divya"
    ]
  },
  {
    "id": "L109",
    "name": "Lakshmi Prasanna",
    "company": "",
    "phone": "95500 66778",
    "area": "Kondapur",
    "source": "Meta Ads",
    "status": "Fresh Lead",
    "assignedTo": null,
    "remarks": "1.5 ton split for bedroom",
    "createdOn": "2026-10-27",
    "address": "",
    "touchedBy": [
      "Divya"
    ]
  },
  {
    "id": "L110",
    "name": "Naveen Reddy",
    "company": "Reddy Associates",
    "phone": "94400 88990",
    "area": "Banjara Hills",
    "source": "Google Ads",
    "status": "Attempted to Contact",
    "assignedTo": null,
    "remarks": "Office of 8 cabins",
    "createdOn": "2026-10-24",
    "address": "",
    "touchedBy": [
      "Divya"
    ]
  },
  {
    "id": "L111",
    "name": "Farhan Ali",
    "company": "Ali Bakers",
    "phone": "98660 22110",
    "area": "Tolichowki",
    "source": "Direct Call",
    "status": "Callback in Future",
    "assignedTo": null,
    "remarks": "Call after Diwali",
    "createdOn": "2026-10-20",
    "address": "",
    "touchedBy": [
      "Divya"
    ]
  },
  {
    "id": "L112",
    "name": "Swathi",
    "company": "Swathi Boutique",
    "phone": "90300 44556",
    "area": "Jubilee Hills",
    "source": "Meta Ads",
    "status": "Callback in Future",
    "assignedTo": "Anil",
    "remarks": "Wants pricing for 3 units, call next week",
    "createdOn": "2026-10-18",
    "address": "",
    "touchedBy": [
      "Divya"
    ]
  },
  {
    "id": "L113",
    "name": "Rajesh Iyer",
    "company": "Iyer Motors",
    "phone": "94900 11223",
    "area": "KPHB",
    "source": "Google Ads",
    "status": "Won",
    "assignedTo": "Ravi",
    "remarks": "2 split ACs for service centre",
    "createdOn": "2026-10-14",
    "address": "",
    "touchedBy": [
      "Anil",
      "Divya"
    ]
  }
];

export const MOCK_HISTORY: Record<string, LeadUpdate[]> = {
  "L101": [
    {
      "date": "2026-10-02",
      "user": "Divya",
      "note": "Result: Quotation Sent · Assigned to Anil"
    },
    {
      "date": "2026-10-02",
      "user": "Divya",
      "note": "Lead created from Meta Ads"
    }
  ],
  "L102": [
    {
      "date": "2026-10-05",
      "user": "Divya",
      "note": "Result: Site Visit Scheduled · Assigned to Ravi"
    },
    {
      "date": "2026-10-05",
      "user": "Divya",
      "note": "Lead created from Google Ads"
    }
  ],
  "L103": [
    {
      "date": "2026-09-21",
      "user": "Divya",
      "note": "Result: Won · Assigned to Anil"
    },
    {
      "date": "2026-09-21",
      "user": "Divya",
      "note": "Lead created from Direct Call"
    }
  ],
  "L104": [
    {
      "date": "2026-10-12",
      "user": "Divya",
      "note": "Result: Contacted · Assigned to Ravi"
    },
    {
      "date": "2026-10-12",
      "user": "Divya",
      "note": "Lead created from Meta Ads"
    }
  ],
  "L105": [
    {
      "date": "2026-10-25",
      "user": "Divya",
      "note": "Lead created from Google Ads"
    }
  ],
  "L106": [
    {
      "date": "2026-10-26",
      "user": "Divya",
      "note": "Lead created from Direct Call"
    }
  ],
  "L107": [
    {
      "date": "2026-09-15",
      "user": "Divya",
      "note": "Result: Lost · Assigned to Anil"
    },
    {
      "date": "2026-09-15",
      "user": "Divya",
      "note": "Lead created from Google Ads"
    }
  ],
  "L108": [
    {
      "date": "2026-10-08",
      "user": "Divya",
      "note": "Result: Quotation Sent · Assigned to Ravi"
    },
    {
      "date": "2026-10-08",
      "user": "Divya",
      "note": "Lead created from Meta Ads"
    }
  ],
  "L109": [
    {
      "date": "2026-10-27",
      "user": "Divya",
      "note": "Lead created from Meta Ads"
    }
  ],
  "L110": [
    {
      "date": "2026-10-24",
      "user": "Divya",
      "note": "Result: Attempted to Contact"
    },
    {
      "date": "2026-10-24",
      "user": "Divya",
      "note": "Lead created from Google Ads"
    }
  ],
  "L111": [
    {
      "date": "2026-10-20",
      "user": "Divya",
      "note": "Result: Callback in Future"
    },
    {
      "date": "2026-10-20",
      "user": "Divya",
      "note": "Lead created from Direct Call"
    }
  ],
  "L112": [
    {
      "date": "2026-10-18",
      "user": "Divya",
      "note": "Result: Callback in Future · Assigned to Anil"
    },
    {
      "date": "2026-10-18",
      "user": "Divya",
      "note": "Lead created from Meta Ads"
    }
  ],
  "L113": [
    {
      "date": "2026-10-14",
      "user": "Anil",
      "note": "Result: Won"
    },
    {
      "date": "2026-10-12",
      "user": "Divya",
      "note": "Result: Site Visit Scheduled · Assigned to Ravi"
    },
    {
      "date": "2026-10-12",
      "user": "Divya",
      "note": "Lead created from Google Ads"
    }
  ]
};

export const MOCK_QUOTES: Quotation[] = [
  {
    "id": "Q2001",
    "offerNo": "225/26-27",
    "leadId": "L101",
    "customer": "Sri Lakshmi Textiles",
    "executive": "Anil",
    "date": "2026-10-10",
    "total": 228000
  },
  {
    "id": "Q2002",
    "offerNo": "226/26-27",
    "leadId": "L103",
    "customer": "Hotel Paradise Inn",
    "executive": "Anil",
    "date": "2026-09-28",
    "total": 366000
  },
  {
    "id": "Q2003",
    "offerNo": "227/26-27",
    "leadId": "L108",
    "customer": "Kiran Motors",
    "executive": "Ravi",
    "date": "2026-10-15",
    "total": 114000
  }
];

export const MOCK_VISITS: Visit[] = [
  {
    "id": "V1",
    "leadId": "L102",
    "customer": "Ramesh Clinic",
    "address": "Plot 45, KPHB Phase 3",
    "area": "Kukatpally",
    "executive": "Ravi",
    "type": "Site survey",
    "isVisit": true,
    "date": "2026-10-29",
    "time": "11:00",
    "status": "Assigned",
    "nextAction": "Measure waiting hall for cassette AC",
    "followUp": "2026-10-30",
    "notes": "",
    "done": false
  },
  {
    "id": "V2",
    "leadId": "L101",
    "customer": "Sri Lakshmi Textiles",
    "address": "6-3-249, Ameerpet Main Rd",
    "area": "Ameerpet",
    "executive": "Anil",
    "type": "Site survey",
    "isVisit": true,
    "date": "2026-10-08",
    "time": "10:30",
    "status": "Completed",
    "nextAction": "Send revised quotation",
    "followUp": "2026-10-12",
    "notes": "Showroom 2,400 sq ft, needs 4 units",
    "done": true
  },
  {
    "id": "V3",
    "leadId": "L103",
    "customer": "Hotel Paradise Inn",
    "address": "SD Road, near Paradise Circle",
    "area": "Secunderabad",
    "executive": "Anil",
    "type": "Installation check",
    "isVisit": true,
    "date": "2026-10-29",
    "time": "15:30",
    "status": "In Progress",
    "nextAction": "Confirm ducting on 3rd floor",
    "followUp": "2026-10-31",
    "notes": "",
    "done": false
  },
  {
    "id": "V4",
    "leadId": "L104",
    "customer": "Sunitha Reddy",
    "address": "Flat 302, My Home Avatar",
    "area": "Gachibowli",
    "executive": "Ravi",
    "type": "Room inspection",
    "isVisit": true,
    "date": "2026-10-31",
    "time": "17:00",
    "status": "Assigned",
    "nextAction": "Recommend 1.5 TR inverter units",
    "followUp": "2026-11-01",
    "notes": "",
    "done": false
  },
  {
    "id": "V5",
    "leadId": "L101",
    "customer": "Sri Lakshmi Textiles",
    "address": "6-3-249, Ameerpet Main Rd",
    "area": "Ameerpet",
    "executive": "Anil",
    "type": "Follow-up call",
    "isVisit": false,
    "date": "2026-10-30",
    "time": "12:00",
    "status": "Assigned",
    "nextAction": "Negotiate final price",
    "followUp": "2026-11-02",
    "notes": "",
    "done": false
  },
  {
    "id": "V6",
    "leadId": "L103",
    "customer": "Hotel Paradise Inn",
    "address": "SD Road, near Paradise Circle",
    "area": "Secunderabad",
    "executive": "Anil",
    "type": "Prepare quotation",
    "isVisit": false,
    "date": "2026-10-28",
    "time": "16:00",
    "status": "In Progress",
    "nextAction": "Share offer on WhatsApp",
    "followUp": "2026-10-30",
    "notes": "",
    "done": false
  },
  {
    "id": "V7",
    "leadId": "L104",
    "customer": "Sunitha Reddy",
    "address": "Flat 302, My Home Avatar",
    "area": "Gachibowli",
    "executive": "Ravi",
    "type": "Demo visit",
    "isVisit": true,
    "date": "2026-10-20",
    "time": "11:30",
    "status": "Completed",
    "nextAction": "Await customer decision",
    "followUp": "2026-10-27",
    "notes": "Customer liked Samsung WindFree",
    "done": true
  },
  {
    "id": "V8",
    "leadId": "L102",
    "customer": "Ramesh Clinic",
    "address": "Plot 45, KPHB Phase 3",
    "area": "Kukatpally",
    "executive": "Ravi",
    "type": "Collect advance",
    "isVisit": true,
    "date": "2026-11-03",
    "time": "10:00",
    "status": "Assigned",
    "nextAction": "Collect 100% equipment advance",
    "followUp": "2026-11-04",
    "notes": "",
    "done": false
  },
  {
    "id": "V9",
    "leadId": "L103",
    "customer": "Hotel Paradise Inn",
    "address": "SD Road, near Paradise Circle",
    "area": "Secunderabad",
    "executive": "Anil",
    "type": "Site survey",
    "isVisit": true,
    "date": "2026-09-26",
    "time": "10:00",
    "status": "Completed",
    "nextAction": "Send quotation",
    "followUp": "2026-09-28",
    "notes": "Confirmed 3 cassette units",
    "done": true
  }
];
